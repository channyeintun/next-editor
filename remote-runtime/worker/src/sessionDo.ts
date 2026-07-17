import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { Env } from "./types";
import { previewResponseHeaders, previewScriptMarkup, previewWebSocketInit } from "./preview";
import { runtimeMetric } from "./telemetry";

interface PreviewScript {
  src: string;
  options: { type?: "module" | "importmap"; defer?: boolean; async?: boolean };
  prelude?: string;
}

interface SessionConfig {
  sessionId: string;
  userId: string;
  createdAt: number;
  idleTimeoutSeconds: number;
  workdirName: string;
}

export class RuntimeGoSessionDO extends Container<Env> {
  defaultPort = 8600;
  requiredPorts = [8600];
  sleepAfter = "5m";
  pingEndpoint = "container/healthz";

  override onStart(): void {
    runtimeMetric("container_started", { sessionId: this.ctx.id.toString() });
  }

  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }): Promise<void> {
    const config = await this.ctx.storage.get<SessionConfig>("sessionConfig");
    if (config) this.applyConfig(config);
    await super.alarm(alarmProps);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime/configure" && request.method === "PUT") {
      let value: unknown;
      try {
        value = await request.json();
      } catch {
        return new Response("invalid session config", { status: 400 });
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return new Response("invalid session config", { status: 400 });
      }
      const config = value as SessionConfig;
      if (
        !config.sessionId ||
        !config.userId ||
        !Number.isFinite(config.createdAt) ||
        !Number.isFinite(config.idleTimeoutSeconds) ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(config.workdirName) ||
        config.workdirName === "." ||
        config.workdirName === ".."
      ) {
        return new Response("invalid session config", { status: 400 });
      }
      config.idleTimeoutSeconds = Math.min(3_600, Math.max(30, config.idleTimeoutSeconds || 300));
      await this.ctx.storage.put("sessionConfig", config);
      this.applyConfig(config);
      this.renewActivityTimeout();
      try {
        await this.startAndWaitForPorts({
          ports: [this.defaultPort],
        });
      } catch (error) {
        await this.destroy().catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        return new Response(`container failed health check: ${message}`, { status: 503 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__runtime/preview-script" && request.method === "PUT") {
      let value: unknown;
      try {
        value = await request.json();
      } catch {
        return new Response("invalid preview script", { status: 400 });
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return new Response("invalid preview script", { status: 400 });
      }
      const script = value as PreviewScript;
      if (
        typeof script.src !== "string" ||
        typeof script.options !== "object" ||
        script.options === null ||
        Array.isArray(script.options) ||
        (script.prelude !== undefined && typeof script.prelude !== "string")
      ) {
        return new Response("invalid preview script", { status: 400 });
      }
      if (
        (script.options.type !== undefined &&
          script.options.type !== "module" &&
          script.options.type !== "importmap") ||
        (script.options.defer !== undefined && typeof script.options.defer !== "boolean") ||
        (script.options.async !== undefined && typeof script.options.async !== "boolean")
      ) {
        return new Response("invalid preview script options", { status: 400 });
      }
      if (script.src.length + (script.prelude?.length ?? 0) > 1024 * 1024) {
        return new Response("script too large", { status: 413 });
      }
      await this.ctx.storage.put("previewScript", script);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__runtime/destroy" && request.method === "DELETE") {
      await this.destroy();
      return new Response(null, { status: 204 });
    }

    const agentPath = url.pathname.startsWith("/__runtime/preview/")
      ? `/proxy/${url.pathname.slice("/__runtime/preview/".length)}${url.search}`
      : `/ws${url.search}`;
    const config = await this.ctx.storage.get<SessionConfig>("sessionConfig");
    if (!config) return new Response("session is not configured", { status: 409 });
    this.applyConfig(config);
    const forwarded = new Request(new URL(agentPath, "http://container"), request);
    const response = await super.fetch(forwarded);
    if (!url.pathname.startsWith("/__runtime/preview/")) return response;
    return this.decoratePreview(response);
  }

  override async onStop(_params: StopParams): Promise<void> {
    const config = await this.ctx.storage.get<SessionConfig>("sessionConfig");
    if (!config || (await this.ctx.storage.get<boolean>("usageFinalized"))) return;
    const endedAt = Date.now();
    const minutes = Math.max(1, Math.ceil((endedAt - config.createdAt) / 60_000));
    const day = new Date(endedAt).toISOString().slice(0, 10);
    await this.env.RUNTIME_QUOTAS.batch([
      this.env.RUNTIME_QUOTAS.prepare(
        "UPDATE runtime_sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL",
      ).bind(endedAt, config.sessionId),
      this.env.RUNTIME_QUOTAS.prepare(`INSERT INTO runtime_daily_usage (user_id, day, minutes) VALUES (?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET minutes = minutes + excluded.minutes`).bind(
        config.userId,
        day,
        minutes,
      ),
    ]);
    await this.ctx.storage.put("usageFinalized", true);
    runtimeMetric("session_stopped", { sessionId: config.sessionId, minutes });
  }

  private async decoratePreview(response: Response): Promise<Response> {
    const headers = previewResponseHeaders(response.headers);
    const webSocketInit = previewWebSocketInit(response, headers);
    if (webSocketInit) return new Response(null, webSocketInit);
    const contentType = headers.get("Content-Type") ?? "";
    const script = await this.ctx.storage.get<PreviewScript>("previewScript");
    if (!script || !contentType.toLowerCase().includes("text/html")) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const markup = previewScriptMarkup(script);
    let injectedIntoHead = false;
    const injected = new HTMLRewriter()
      .on("head", {
        element(element) {
          if (injectedIntoHead) return;
          injectedIntoHead = true;
          element.append(markup, { html: true });
        },
      })
      .onDocument({
        end(end) {
          if (!injectedIntoHead) end.append(markup, { html: true });
        },
      })
      .transform(
        new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
      );
    return injected;
  }

  private applyConfig(config: SessionConfig): void {
    this.sleepAfter = `${config.idleTimeoutSeconds}s`;
    this.enableInternet = true;
    this.envVars = { REMOTE_RUNTIME_WORKSPACE: `/workspace/${config.workdirName}` };
  }
}

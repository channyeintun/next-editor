import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { Env } from "./types";
import { previewResponseHeaders, previewScriptMarkup } from "./preview";
import { runtimeMetric } from "./telemetry";

interface PreviewScript {
  src: string;
  options: { type?: "module" | "importmap"; defer?: boolean; async?: boolean };
}

interface SessionConfig { sessionId: string; userId: string; createdAt: number; idleTimeoutSeconds: number }

export class RuntimeGoSessionDO extends Container<Env> {
  defaultPort = 8600;
  requiredPorts = [8600];
  sleepAfter = "5m";

  override onStart(): void {
    runtimeMetric("container_started", { sessionId: this.ctx.id.toString() });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime/configure" && request.method === "PUT") {
      const config = await request.json<SessionConfig>();
      if (!config.sessionId || !config.userId || !Number.isFinite(config.createdAt)) {
        return new Response("invalid session config", { status: 400 });
      }
      config.idleTimeoutSeconds = Math.min(3_600, Math.max(30, config.idleTimeoutSeconds || 300));
      this.sleepAfter = `${config.idleTimeoutSeconds}s`;
      await this.ctx.storage.put("sessionConfig", config);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__runtime/preview-script" && request.method === "PUT") {
      const script = await request.json<PreviewScript>();
      if (script.src.length > 1024 * 1024) return new Response("script too large", { status: 413 });
      await this.ctx.storage.put("previewScript", script);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__runtime/destroy" && request.method === "DELETE") {
      await this.stop();
      return new Response(null, { status: 204 });
    }

    const agentPath = url.pathname.startsWith("/__runtime/preview/")
      ? `/proxy/${url.pathname.slice("/__runtime/preview/".length)}${url.search}`
      : `/ws${url.search}`;
    const forwarded = new Request(new URL(agentPath, "http://container"), request);
    const response = await super.fetch(forwarded);
    if (!url.pathname.startsWith("/__runtime/preview/")) return response;
    return this.decoratePreview(response);
  }

  override async onStop(_params: StopParams): Promise<void> {
    const config = await this.ctx.storage.get<SessionConfig>("sessionConfig");
    if (!config || await this.ctx.storage.get<boolean>("usageFinalized")) return;
    const endedAt = Date.now();
    const minutes = Math.max(1, Math.ceil((endedAt - config.createdAt) / 60_000));
    const day = new Date(endedAt).toISOString().slice(0, 10);
    await this.env.RUNTIME_QUOTAS.batch([
      this.env.RUNTIME_QUOTAS.prepare(
        "UPDATE runtime_sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL",
      ).bind(endedAt, config.sessionId),
      this.env.RUNTIME_QUOTAS.prepare(`INSERT INTO runtime_daily_usage (user_id, day, minutes) VALUES (?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET minutes = minutes + excluded.minutes`).bind(config.userId, day, minutes),
    ]);
    await this.ctx.storage.put("usageFinalized", true);
    runtimeMetric("session_stopped", { sessionId: config.sessionId, minutes });
  }

  private async decoratePreview(response: Response): Promise<Response> {
    const headers = previewResponseHeaders(response.headers);
    const contentType = headers.get("Content-Type") ?? "";
    const script = await this.ctx.storage.get<PreviewScript>("previewScript");
    if (!script || !contentType.toLowerCase().includes("text/html")) {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    const markup = previewScriptMarkup(script);
    const injected = new HTMLRewriter().on("head", {
      element(element) { element.append(markup, { html: true }); },
    }).transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
    return injected;
  }
}

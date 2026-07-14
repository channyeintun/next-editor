import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

interface PreviewScript {
  src: string;
  options: { type?: "module" | "importmap"; defer?: boolean; async?: boolean };
}

export class RuntimeGoSessionDO extends Container<Env> {
  defaultPort = 8600;
  requiredPorts = [8600];
  sleepAfter = "5m";

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime/preview-script" && request.method === "PUT") {
      const script = await request.json<PreviewScript>();
      if (script.src.length > 1024 * 1024) return new Response("script too large", { status: 413 });
      await this.ctx.storage.put("previewScript", script);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__runtime/destroy" && request.method === "DELETE") {
      await this.stop();
      await this.ctx.storage.deleteAll();
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

  private async decoratePreview(response: Response): Promise<Response> {
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Cross-Origin-Embedder-Policy", "unsafe-none");
    headers.delete("Set-Cookie");
    const contentType = headers.get("Content-Type") ?? "";
    const script = await this.ctx.storage.get<PreviewScript>("previewScript");
    if (!script || !contentType.toLowerCase().includes("text/html")) {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    const attributes = [
      script.options.type ? `type="${script.options.type}"` : "",
      script.options.defer ? "defer" : "",
      script.options.async ? "async" : "",
    ].filter(Boolean).join(" ");
    const injected = new HTMLRewriter().on("head", {
      element(element) { element.append(`<script ${attributes}>${script.src.replaceAll("</script", "<\\/script")}</script>`, { html: true }); },
    }).transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
    return injected;
  }
}

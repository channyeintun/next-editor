export function previewResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Cross-Origin-Embedder-Policy", "unsafe-none");
  headers.delete("Set-Cookie");
  return headers;
}

export function previewWebSocketInit(
  response: Pick<Response, "webSocket">,
  headers: Headers,
): ResponseInit | undefined {
  return response.webSocket ? { status: 101, headers, webSocket: response.webSocket } : undefined;
}

export function previewScriptMarkup(script: {
  src: string;
  options: { type?: "module" | "importmap"; defer?: boolean; async?: boolean };
  prelude?: string;
}): string {
  const escapeScript = (source: string) => source.replace(/<\/script/gi, "<\\/script");
  const attributes = [
    script.options.type ? `type="${script.options.type}"` : "",
    script.options.defer ? "defer" : "",
    script.options.async ? "async" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const prelude = script.prelude ? `<script>${escapeScript(script.prelude)}</script>` : "";
  return `${prelude}<script${attributes ? ` ${attributes}` : ""}>${escapeScript(script.src)}</script>`;
}

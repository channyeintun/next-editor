export function previewResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Cross-Origin-Embedder-Policy", "unsafe-none");
  headers.delete("Set-Cookie");
  return headers;
}

export function previewScriptMarkup(script: {
  src: string;
  options: { type?: "module" | "importmap"; defer?: boolean; async?: boolean };
}): string {
  const attributes = [
    script.options.type ? `type="${script.options.type}"` : "",
    script.options.defer ? "defer" : "",
    script.options.async ? "async" : "",
  ].filter(Boolean).join(" ");
  return `<script${attributes ? ` ${attributes}` : ""}>${script.src.replaceAll("</script", "<\\/script")}</script>`;
}

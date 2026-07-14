import { describe, expect, it } from "vitest";
import { previewResponseHeaders, previewScriptMarkup } from "./preview";

describe("preview ingress", () => {
  it("sets embedder headers and strips sandbox cookies", () => {
    const headers = previewResponseHeaders(new Headers({ "Set-Cookie": "bad=1" }));
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(headers.get("Cross-Origin-Embedder-Policy")).toBe("unsafe-none");
    expect(headers.has("Set-Cookie")).toBe(false);
  });

  it("renders attributes and prevents script-tag breakout", () => {
    expect(previewScriptMarkup({ src: "x='</script><p>'", options: { type: "module", defer: true } }))
      .toBe(`<script type="module" defer>x='<\\/script><p>'</script>`);
  });
});

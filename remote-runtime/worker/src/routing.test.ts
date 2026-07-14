import { describe, expect, it } from "vitest";
import { previewTarget } from "./routing";

describe("preview routing", () => {
  it("parses path-based development URLs", () => {
    expect(previewTarget(new Request("http://localhost/preview/abcd-1234/8080/assets/app.js")))
      .toEqual({ sessionId: "abcd-1234", port: 8080, path: "/assets/app.js" });
  });

  it("parses separate-domain and single-level production hosts", () => {
    expect(previewTarget(new Request("https://p3000-abcd.preview.example/path")))
      .toEqual({ sessionId: "abcd", port: 3000, path: "/path" });
    expect(previewTarget(new Request("https://p3000-abcd-preview.example/path")))
      .toEqual({ sessionId: "abcd", port: 3000, path: "/path" });
  });
});

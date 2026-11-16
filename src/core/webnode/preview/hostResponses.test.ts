// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPreviewConnectHtml } from "./connectPage";
import { RUNTIME_FRAME_PATH, webnodeHostAsset, webnodeHostResponse } from "./hostResponses";

const EDITOR = "https://editor.example";

describe("webnodeHostAsset", () => {
  it("names the scripts a runtime host serves and nothing else", () => {
    expect(webnodeHostAsset("/__webnode__/sw.js")).toBe("preview-sw.js");
    expect(webnodeHostAsset("/__webnode__/runtime.js")).toBe("runtime.js");
    expect(webnodeHostAsset("/__webnode__/kernel.js")).toBe("kernel.js");
    expect(webnodeHostAsset("/__webnode__/process.js")).toBe("process.js");
    expect(webnodeHostAsset("/")).toBeNull();
    expect(webnodeHostAsset("/__webnode__/other.js")).toBeNull();
    expect(webnodeHostAsset("/src/main.ts")).toBeNull();
  });
});

describe("webnodeHostResponse", () => {
  it("serves the service worker, told who the editor is", () => {
    const response = webnodeHostResponse("/__webnode__/sw.js", {
      editorOrigin: EDITOR,
      assetSource: "/* worker */",
    });
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
    });
    expect(response.body).toBe(
      `self.__WEBNODE_EDITOR_ORIGIN__ = "https://editor.example";\n/* worker */`,
    );
  });

  it("serves the kernel and process scripts unchanged", () => {
    for (const path of ["/__webnode__/kernel.js", "/__webnode__/process.js"]) {
      const response = webnodeHostResponse(path, { editorOrigin: EDITOR, assetSource: "code();" });
      expect(response.body).toBe("code();");
      expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
      expect(response.headers["service-worker-allowed"]).toBeUndefined();
    }
  });

  it("answers 404 for a script the host could not read", () => {
    expect(
      webnodeHostResponse("/__webnode__/kernel.js", { editorOrigin: EDITOR, assetSource: null })
        .status,
    ).toBe(404);
  });

  it("serves the runtime frame, framable by the editor only", () => {
    const response = webnodeHostResponse(RUNTIME_FRAME_PATH, {
      editorOrigin: EDITOR,
      assetSource: null,
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('<script src="/__webnode__/runtime.js"></script>');
    expect(response.headers["content-security-policy"]).toBe(`frame-ancestors ${EDITOR}`);
    expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("serves the connect page for every other path", () => {
    for (const path of ["/", "/index.html", "/src/main.ts", "/__webnode__/other"]) {
      const response = webnodeHostResponse(path, { editorOrigin: EDITOR, assetSource: null });
      expect(response.status).toBe(200);
      expect(response.body).toBe(createPreviewConnectHtml(EDITOR));
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toBe(`frame-ancestors ${EDITOR}`);
    }
  });
});

describe("createPreviewConnectHtml", () => {
  it("is a self-contained document whose script parses", () => {
    const html = createPreviewConnectHtml(EDITOR);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Connecting to preview…");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
  });

  it("takes a connection only from the editor and asks only the editor", () => {
    const html = createPreviewConnectHtml(EDITOR);
    expect(html).toContain('var EDITOR = "https://editor.example";');
    expect(html).toContain("event.origin !== EDITOR");
    expect(html).toContain('{ type: "webnode:preview-connect" }, EDITOR)');
    expect(html).not.toContain('"*"');
  });
});

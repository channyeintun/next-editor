import { describe, expect, it } from "vite-plus/test";
import { createReplayableRuntimePreviewFromHtml } from "./previewIframeUtils";

const BASE_URL = "https://abc--3000--xyz.local-corp.webcontainer-api.io/";

describe("createReplayableRuntimePreviewFromHtml", () => {
  it("drops every script and anchors relative URLs with one leading <base>", () => {
    const snapshot = createReplayableRuntimePreviewFromHtml(
      '<html><head><title>App</title><base href="/old/"><script src="/a.js"></script></head>' +
        '<body><h1>Hi</h1><script>window.x = 1</script><img src="logo.png"></body></html>',
      BASE_URL,
    );

    expect(snapshot).toBe(
      `<!doctype html>\n<html><head><base href="${BASE_URL}"><title>App</title></head>` +
        '<body><h1>Hi</h1><img src="logo.png"></body></html>',
    );
  });
});

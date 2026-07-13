import { describe, expect, it } from "vitest";
import { makeCtx, makeFile, makeStore } from "./testUtils";
import { makeRuntimeDiagnosticsTool } from "./runtimeDiagnostics";
import { makeInspectPreviewTool } from "./inspectPreview";
import { makeCapturePreviewTool } from "./capturePreview";

function makeBaseContext() {
  return makeCtx(makeStore([makeFile("index.html", "<main>Hello</main>")]));
}

describe("runtime observation tools", () => {
  it("returns live runtime and preview errors without running a command", async () => {
    const ctx = makeBaseContext();
    ctx.getRuntimeDiagnostics = () => ({
      activeCommand: "pnpm dev",
      errorMessage: "runner failed",
      isSupported: true,
      lastOutput: "SyntaxError: unexpected token",
      latestLifecycleEvent: {
        id: 1,
        kind: "internal-error",
        text: "runner failed",
        port: null,
        url: null,
      },
      latestPreviewMessage: {
        id: 1,
        kind: "uncaught-exception",
        text: "ReferenceError: missingValue",
        port: 5173,
        pathname: "/lesson",
      },
      previewPort: 5173,
      previewUrl: "https://preview.example/lesson",
      status: "error",
    });

    const result = await makeRuntimeDiagnosticsTool(ctx).function.execute({});

    expect(result).toContain("Status: error");
    expect(result).toContain("ReferenceError: missingValue");
    expect(result).toContain("SyntaxError: unexpected token");
  });

  it("returns visible text and bounded live HTML", async () => {
    const ctx = makeBaseContext();
    ctx.getPreviewInspection = () => ({
      capturedAt: 1_700_000_000_000,
      height: 720,
      html: "<html><body><main>Hello <strong>preview</strong></main><script>hidden()</script></body></html>",
      route: "/lesson",
      url: "https://preview.example/lesson",
      width: 1280,
    });

    const result = await makeInspectPreviewTool(ctx).function.execute({
      includeHtml: true,
      maxHtmlChars: 1_000,
    });

    expect(result).toContain("Route: /lesson");
    expect(result).toContain("Viewport: 1280x720");
    expect(result).toContain("Hello preview");
    expect(result).toContain("Rendered HTML");
  });

  it("returns a captured PNG as an image tool result", async () => {
    const ctx = makeBaseContext();
    ctx.capturePreviewScreenshot = async () => ({
      dataUrl: "data:image/png;base64,aGVsbG8=",
      height: 720,
      width: 1280,
    });

    const result = await makeCapturePreviewTool(ctx).function.execute({});

    expect(result).toEqual([
      {
        type: "input_text",
        text: expect.stringContaining("1280x720"),
      },
      {
        type: "input_image",
        imageUrl: "data:image/png;base64,aGVsbG8=",
        detail: "high",
      },
    ]);
  });
});

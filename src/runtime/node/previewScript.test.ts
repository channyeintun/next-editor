import { describe, expect, it, vi } from "vite-plus/test";
import { createRuntimePreviewScript } from "./previewScript";

describe("createRuntimePreviewScript", () => {
  it("bundles the rrweb recorder and snapshot wiring into one injectable script", () => {
    const script = createRuntimePreviewScript();

    expect(script).toContain("window.rrwebRecord.record");
    // The vendored UMD bundle is inlined (its IIFE header is present).
    expect(script).toContain("function (g, f)");
    // The snapshot/postMessage wiring keyed on the runtime snapshot message type.
    expect(script).toContain("NEXT_EDITOR_RUNTIME_SNAPSHOT");
    expect(script).toContain("NEXT_EDITOR_REQUEST_RUNTIME_SNAPSHOT");
    expect(script).not.toContain("new MutationObserver(schedule)");
    expect(script).toContain('window.addEventListener("message"');
    expect(script).toContain("minIntervalMs=100");
    expect(script).toContain("NEXT_EDITOR_PREVIEW_SCREENSHOT_REQUEST");
    expect(script).toContain("NEXT_EDITOR_PREVIEW_SCREENSHOT_RESPONSE");
    expect(script).toContain("NEXT_EDITOR_STUDIO_PREVIEW_COMMAND");
    expect(script).toContain("NEXT_EDITOR_STUDIO_PREVIEW_COMMAND_RESPONSE");
    expect(script).toContain("Preview target data-testid=");
  });

  it("starts with the script that keeps the page's picture across a reload", () => {
    const script = createRuntimePreviewScript();

    // Ahead of the recorder: it decides what a new document shows first.
    expect(script.indexOf("__NEXT_EDITOR_RUNTIME_RELOAD_HOLD__")).toBeGreaterThan(-1);
    expect(script.indexOf("__NEXT_EDITOR_RUNTIME_RELOAD_HOLD__")).toBeLessThan(
      script.indexOf("window.rrwebRecord.record"),
    );
  });

  it("runs only in a framed preview, as one valid script", () => {
    const script = createRuntimePreviewScript();

    expect(script.startsWith("if(window.parent!==window){")).toBe(true);
    expect(script.endsWith("}")).toBe(true);
    // The guard wraps every part: a part that broke out of it would not parse.
    expect(() => new Function(script)).not.toThrow();
  });

  it("does nothing in a preview opened in a browser tab of its own", () => {
    // The test's window is a top-level one, as that tab's is: no editor above it.
    expect(window.parent).toBe(window);
    const log = console.log;
    const error = console.error;
    const listen = vi.spyOn(window, "addEventListener");

    new Function(createRuntimePreviewScript())();

    // No recorder, no bridges, no listeners: the page runs as the project wrote it.
    expect(Object.keys(window).filter((key) => key.startsWith("__NEXT_EDITOR_"))).toEqual([]);
    expect((window as { rrwebRecord?: unknown }).rrwebRecord).toBeUndefined();
    expect(listen).not.toHaveBeenCalled();
    // The page's logs reach DevTools from their own lines, not through a bridge.
    expect(console.log).toBe(log);
    expect(console.error).toBe(error);
    listen.mockRestore();
  });

  it("still instruments a preview framed by the editor", () => {
    const posted: unknown[] = [];
    const framed = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    });
    try {
      new Function(createRuntimePreviewScript())();

      const markers = Object.keys(window).filter((key) => key.startsWith("__NEXT_EDITOR_"));
      expect(markers).toEqual(
        expect.arrayContaining([
          "__NEXT_EDITOR_RUNTIME_RRWEB_RECORD__",
          "__NEXT_EDITOR_RUNTIME_SNAPSHOT__",
          "__NEXT_EDITOR_RUNTIME_SCREENSHOT_BRIDGE__",
          "__NEXT_EDITOR_RUNTIME_STUDIO_COMMAND__",
          "__NEXT_EDITOR_RUNTIME_API_CLIENT_PROXY__",
        ]),
      );
    } finally {
      if (framed) Object.defineProperty(window, "parent", framed);
    }
  });

  it("emits no closing </script> so it survives being wrapped in a <script> tag", () => {
    // setPreviewScript supplies the surrounding <script> tag; a literal </script>
    // inside the bundle/wiring would close it early and break every preview.
    const script = createRuntimePreviewScript();
    const closings = script.match(/<\/script>/gi)?.length ?? 0;

    expect(closings).toBe(0);
  });
});

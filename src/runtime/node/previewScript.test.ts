import { describe, expect, it } from "vite-plus/test";
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

  it("emits no closing </script> so it survives being wrapped in a <script> tag", () => {
    // setPreviewScript supplies the surrounding <script> tag; a literal </script>
    // inside the bundle/wiring would close it early and break every preview.
    const script = createRuntimePreviewScript();
    const closings = script.match(/<\/script>/gi)?.length ?? 0;

    expect(closings).toBe(0);
  });
});

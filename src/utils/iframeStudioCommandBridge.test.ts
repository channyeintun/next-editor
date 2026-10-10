import { describe, expect, it, vi } from "vite-plus/test";
import { createStudioPreviewCommandBridgeScript } from "./iframeStudioCommandBridge";

describe("createStudioPreviewCommandBridgeScript", () => {
  it("embeds the setup marker as a JSON string literal", () => {
    expect(
      createStudioPreviewCommandBridgeScript("__NEXT_EDITOR_RUNTIME_STUDIO_COMMAND__"),
    ).toContain('var marker = "__NEXT_EDITOR_RUNTIME_STUDIO_COMMAND__";');
  });

  it("guards on the exact marker even when it holds quotes or replacement patterns", () => {
    const marker = `__TEST_"MARKER"_$&_$1__`;
    const script = createStudioPreviewCommandBridgeScript(marker);
    expect(script).toContain(`var marker = ${JSON.stringify(marker)};`);

    const frameWindow: Record<string, unknown> = {
      addEventListener: vi.fn<() => void>(),
    };
    new Function("window", script)(frameWindow);

    expect(frameWindow[marker]).toBe(true);
    expect(frameWindow.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });
});

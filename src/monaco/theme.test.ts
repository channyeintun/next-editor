import { describe, expect, it } from "vite-plus/test";
import { getEditorOptions } from "./theme";

describe("getEditorOptions", () => {
  it.each([true, false])("keeps worker-backed decorations off (isPlaying: %s)", (isPlaying) => {
    const options = getEditorOptions(isPlaying);

    // Each of these would query a language worker as the text or cursor
    // changes; see languageServiceModes.ts.
    expect(options.inlayHints).toEqual({ enabled: "off" });
    expect(options.lightbulb).toEqual({ enabled: "off" });
    expect(options.renderValidationDecorations).toBe("off");
    // Sticky scroll stays on, with lines picked by indentation instead of the
    // worker's symbol outline.
    expect(options.stickyScroll).toEqual({ defaultModel: "indentationModel" });
  });
});

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

  it("pins the text grid every lesson was recorded on", () => {
    const options = getEditorOptions(false);

    // Recorded pointer samples are pixel offsets over this grid. Leaving the
    // line height to Monaco would give 19px instead of 21px off macOS.
    expect(options.fontFamily).toBe('"Source Code Pro", "Noto Sans Myanmar"');
    expect(options.fontSize).toBe(14);
    expect(options.lineHeight).toBe(21);
  });
});

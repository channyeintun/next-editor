import { describe, expect, it } from "vite-plus/test";
import { dialogDisplayText, splitIntoDialogs } from "./dialogs";
import { extractNarration } from "./markers";

describe("splitIntoDialogs", () => {
  it("splits at markers and scene boundaries, covering every token in order", () => {
    const extracted = extractNarration([
      { sceneId: "a", narration: "Intro words here. [[mark:one]] After the first mark." },
      { sceneId: "b", narration: "[[mark:two]] Second scene speaks." },
    ]);
    const dialogs = splitIntoDialogs(extracted);

    expect(dialogs.map((dialog) => dialog.id)).toEqual(["a.0", "a.1", "b.0"]);
    expect(dialogDisplayText(dialogs[0])).toBe("Intro words here.");
    expect(dialogDisplayText(dialogs[1])).toBe("After the first mark.");
    expect(dialogDisplayText(dialogs[2])).toBe("Second scene speaks.");

    // Full coverage, in order.
    const rejoined = dialogs.flatMap((dialog) => dialog.tokens);
    expect(rejoined).toEqual(extracted.tokens);
    expect(dialogs[1].firstTokenIndex).toBe(3);
    expect(dialogs[2].firstTokenIndex).toBe(extracted.scenes[1].firstTokenIndex);
  });

  it("maps every marker onto a dialog start (or the narration end)", () => {
    const extracted = extractNarration([
      { sceneId: "a", narration: "Lead in. [[mark:mid]] Middle span. [[mark:end]]" },
    ]);
    const dialogs = splitIntoDialogs(extracted);
    const starts = new Set(dialogs.map((dialog) => dialog.firstTokenIndex));

    const mid = extracted.markers.get("mid")!;
    expect(starts.has(mid.beforeTokenIndex)).toBe(true);
    // A trailing marker points past the last token — no dialog starts there.
    const end = extracted.markers.get("end")!;
    expect(end.beforeTokenIndex).toBe(extracted.tokens.length);
  });

  it("collapses adjacent markers without text between them", () => {
    const extracted = extractNarration([
      { sceneId: "a", narration: "Before. [[mark:x]] [[mark:y]] After." },
    ]);
    const dialogs = splitIntoDialogs(extracted);
    expect(dialogs.map((dialog) => dialogDisplayText(dialog))).toEqual(["Before.", "After."]);
    // Both markers bind to the same boundary.
    expect(extracted.markers.get("x")!.beforeTokenIndex).toBe(
      extracted.markers.get("y")!.beforeTokenIndex,
    );
  });
});

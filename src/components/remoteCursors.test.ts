import { describe, expect, it, vi } from "vite-plus/test";
import type { CollaborationParticipant } from "../contexts/CollaborationContext";
import { collaborationParticipantColorIndex } from "../collaboration/relativePosition";
import { collaborationParticipantKey } from "../collaboration/participantKey";

// The real "../monaco" loads the whole editor. These helpers only construct
// ranges, so a plain Range stands in for Monaco's.
vi.mock("../monaco", () => {
  class Range {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;

    constructor(
      startLineNumber: number,
      startColumn: number,
      endLineNumber: number,
      endColumn: number,
    ) {
      this.startLineNumber = startLineNumber;
      this.startColumn = startColumn;
      this.endLineNumber = endLineNumber;
      this.endColumn = endColumn;
    }
  }
  return { monaco: { Range } };
});

import { monaco } from "../monaco";
import {
  participantCursorDecorations,
  remoteSelectionDecorations,
  remoteSelectionToEditorSelection,
  resolveRemoteSelection,
  yMonacoSelectionStyleRules,
} from "./remoteCursors";

/** Just enough of a Monaco model over `text` to place offsets. */
function modelOver(text: string) {
  return {
    getPositionAt(offset: number) {
      const lines = text.slice(0, Math.max(0, Math.min(offset, text.length))).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 };
    },
  };
}

// Line 1 is "const a = 1;" (offsets 0–12), line 2 is "const b = 2;" (13–25).
const model = modelOver("const a = 1;\nconst b = 2;");

function range(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
) {
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}

function participant(name: string | null): CollaborationParticipant {
  return {
    kind: "state",
    roomId: "20000000-0000-4000-8000-000000000001",
    actorId: "30000000-0000-4000-8000-000000000002",
    sessionId: "40000000-0000-4000-8000-000000000002",
    revision: 1,
    role: "editor",
    username: "ada",
    name,
    avatarUrl: null,
    isHost: false,
    surface: { kind: "editor", fileNodeId: null, viewport: null },
    cursor: null,
    occurredAt: 1,
    expiresAt: 2,
  };
}

describe("resolveRemoteSelection", () => {
  it("keeps anchor and head and orders start before end for a forward selection", () => {
    expect(resolveRemoteSelection(model, 6, 19)).toEqual({
      anchor: { lineNumber: 1, column: 7 },
      head: { lineNumber: 2, column: 7 },
      start: { lineNumber: 1, column: 7 },
      end: { lineNumber: 2, column: 7 },
      hasSelectedText: true,
    });
  });

  it("orders start before end for a selection made backwards", () => {
    expect(resolveRemoteSelection(model, 19, 6)).toEqual({
      anchor: { lineNumber: 2, column: 7 },
      head: { lineNumber: 1, column: 7 },
      start: { lineNumber: 1, column: 7 },
      end: { lineNumber: 2, column: 7 },
      hasSelectedText: true,
    });
  });

  it("has no selected text when anchor and head are the same offset", () => {
    expect(resolveRemoteSelection(model, 4, 4).hasSelectedText).toBe(false);
  });

  it("compares offsets, not positions, to decide whether text is selected", () => {
    // Both offsets are past the end, so Monaco places them at the same position.
    const selection = resolveRemoteSelection(model, 40, 50);
    expect(selection.start).toEqual(selection.end);
    expect(selection.hasSelectedText).toBe(true);
  });
});

describe("remoteSelectionDecorations", () => {
  it("draws only a caret, in the participant's colour, when nothing is selected", () => {
    expect(remoteSelectionDecorations(resolveRemoteSelection(model, 4, 4), 3, "Ada")).toEqual([
      {
        range: range(1, 5, 1, 5),
        options: {
          beforeContentClassName: "collaboration-cursor collaboration-color-3",
          hoverMessage: { value: "Ada" },
        },
      },
    ]);
  });

  it("highlights the selected text before drawing the caret at the head", () => {
    const decorations = remoteSelectionDecorations(resolveRemoteSelection(model, 19, 6), 5, "Ada");
    for (const decoration of decorations) expect(decoration.range).toBeInstanceOf(monaco.Range);
    expect(decorations).toEqual([
      {
        range: range(1, 7, 2, 7),
        options: {
          className: "collaboration-selection collaboration-color-5",
          hoverMessage: { value: "Ada" },
        },
      },
      {
        range: range(1, 7, 1, 7),
        options: {
          beforeContentClassName: "collaboration-cursor collaboration-color-5",
          hoverMessage: { value: "Ada" },
        },
      },
    ]);
  });

  it("escapes Markdown in the hovered name so it cannot render a link or image", () => {
    const [selectionDecoration, caretDecoration] = remoteSelectionDecorations(
      resolveRemoteSelection(model, 0, 5),
      0,
      "![x](https://example.test/a.png) *Ada*",
    );
    const escaped = "\\!\\[x\\]\\(https://example\\.test/a\\.png\\) \\*Ada\\*";
    expect(selectionDecoration.options.hoverMessage).toEqual({ value: escaped });
    expect(caretDecoration.options.hoverMessage).toEqual({ value: escaped });
  });
});

describe("participantCursorDecorations", () => {
  it("draws the participant's cursor and labels its caret with their name", () => {
    const ada = participant(" Ada Lovelace ");
    const key = collaborationParticipantKey(ada);
    const colorIndex = collaborationParticipantColorIndex(ada);

    const drawn = participantCursorDecorations(model, key, ada, {
      anchorOffset: 6,
      headOffset: 19,
    });

    expect(drawn.decorations).toEqual(
      remoteSelectionDecorations(resolveRemoteSelection(model, 6, 19), colorIndex, "Ada Lovelace"),
    );
    expect(drawn.label).toEqual({
      id: key,
      name: "Ada Lovelace",
      colorIndex,
      position: { lineNumber: 2, column: 7 },
    });
  });

  it("falls back to the username for a participant without a name", () => {
    const drawn = participantCursorDecorations(model, "key", participant(null), {
      anchorOffset: 0,
      headOffset: 0,
    });
    expect(drawn.label.name).toBe("ada");
  });
});

describe("remoteSelectionToEditorSelection", () => {
  it("records the ordered range together with where the selection started and ended", () => {
    expect(remoteSelectionToEditorSelection(resolveRemoteSelection(model, 19, 6))).toEqual({
      startLineNumber: 1,
      startColumn: 7,
      endLineNumber: 2,
      endColumn: 7,
      selectionStartLineNumber: 2,
      selectionStartColumn: 7,
      positionLineNumber: 1,
      positionColumn: 7,
    });
  });
});

describe("yMonacoSelectionStyleRules", () => {
  it("colours one client's y-monaco selection and caret", () => {
    expect(yMonacoSelectionStyleRules(42, 1)).toEqual([
      ".monaco-editor .yRemoteSelection-42{background:rgb(52 211 153 / 28%);border-radius:2px}",
      ".monaco-editor .yRemoteSelectionHead-42{display:inline-block;height:1.2em;margin-left:-1px;border-left:2px solid #34d399;vertical-align:text-bottom}",
    ]);
  });

  it("uses the first colour for a colour index outside the palette", () => {
    expect(yMonacoSelectionStyleRules(7, 99)).toEqual(yMonacoSelectionStyleRules(7, 0));
  });
});

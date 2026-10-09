import { describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import type { CollaborationParticipant } from "../contexts/CollaborationContext";
import type { ResolvedMonacoAwarenessSelection } from "../collaboration/monacoAwareness";
import { getCollaborationTexts } from "../collaboration/projectDocument";
import { createCollaborationCursor } from "../collaboration/relativePosition";
import { collaborationParticipantKey } from "../collaboration/participantKey";
import { collaboratorColorIndex } from "./collaboratorAppearance";

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
  collectRemoteEditorSelections,
  participantCursorDecorations,
  remoteSelectionDecorations,
  remoteSelectionToEditorSelection,
  resolveAwarenessText,
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

function participant(name: string | null, sessionId = "2"): CollaborationParticipant {
  return {
    kind: "state",
    roomId: "20000000-0000-4000-8000-000000000001",
    actorId: "30000000-0000-4000-8000-000000000002",
    sessionId: `40000000-0000-4000-8000-00000000000${sessionId}`,
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
    const colorIndex = collaboratorColorIndex(ada);

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

describe("collectRemoteEditorSelections", () => {
  // The open file is "file-1"; "file-2" is another file in the room.
  const doc = new Y.Doc();
  getCollaborationTexts(doc).set("file-1", new Y.Text("const a = 1;\nconst b = 2;"));
  getCollaborationTexts(doc).set("file-2", new Y.Text("other"));

  function withCursor(
    person: CollaborationParticipant,
    fileNodeId: string,
    anchorOffset: number,
    headOffset: number,
  ): CollaborationParticipant {
    return {
      ...person,
      cursor: createCollaborationCursor(doc, fileNodeId, anchorOffset, headOffset),
    };
  }

  function awarenessSelection(
    person: CollaborationParticipant,
    clientId: number,
    anchorOffset: number,
    headOffset: number,
  ): ResolvedMonacoAwarenessSelection {
    return { clientId, participant: person, anchorOffset, headOffset };
  }

  const ada = participant("Ada", "2");
  const grace = participant("Grace", "3");
  const linus = participant("Linus", "4");

  it("lists awareness selections first and skips a participant already among them", () => {
    const selections = collectRemoteEditorSelections({
      awarenessSelections: [awarenessSelection(ada, 7, 0, 5)],
      doc,
      participants: [withCursor(grace, "file-1", 13, 19), withCursor(ada, "file-1", 1, 1)],
      ownParticipantKey: null,
      activeFileNodeId: "file-1",
    });

    expect(selections).toEqual([
      {
        key: collaborationParticipantKey(ada),
        participant: ada,
        anchorOffset: 0,
        headOffset: 5,
        fromAwareness: true,
        clientId: 7,
      },
      {
        key: collaborationParticipantKey(grace),
        participant: withCursor(grace, "file-1", 13, 19),
        anchorOffset: 13,
        headOffset: 19,
        fromAwareness: false,
      },
    ]);
  });

  it("skips this tab's own cursor, a participant without one and one in another file", () => {
    const selections = collectRemoteEditorSelections({
      awarenessSelections: [],
      doc,
      participants: [withCursor(ada, "file-1", 2, 2), grace, withCursor(linus, "file-2", 1, 1)],
      ownParticipantKey: collaborationParticipantKey(ada),
      activeFileNodeId: "file-1",
    });

    expect(selections).toEqual([]);
  });

  it("lists only collaboration cursors when there are no awareness selections", () => {
    const selections = collectRemoteEditorSelections({
      awarenessSelections: [],
      doc,
      participants: [withCursor(ada, "file-1", 4, 4), withCursor(grace, "file-1", 13, 25)],
      ownParticipantKey: null,
      activeFileNodeId: "file-1",
    });

    expect(
      selections.map(({ key, anchorOffset, headOffset, fromAwareness }) => ({
        key,
        anchorOffset,
        headOffset,
        fromAwareness,
      })),
    ).toEqual([
      {
        key: collaborationParticipantKey(ada),
        anchorOffset: 4,
        headOffset: 4,
        fromAwareness: false,
      },
      {
        key: collaborationParticipantKey(grace),
        anchorOffset: 13,
        headOffset: 25,
        fromAwareness: false,
      },
    ]);
  });

  it("lists no collaboration cursor while the open file is not in the room", () => {
    const selections = collectRemoteEditorSelections({
      awarenessSelections: [],
      doc,
      participants: [withCursor(ada, "file-1", 4, 4)],
      ownParticipantKey: null,
      activeFileNodeId: undefined,
    });

    expect(selections).toEqual([]);
  });
});

describe("resolveAwarenessText", () => {
  const editor = {};
  const model = {};
  const boundText = new Y.Text();
  const roomText = new Y.Text();

  it("uses the text y-monaco binds to this editor and model, and lets y-monaco draw", () => {
    const fallback = vi.fn<() => Y.Text | undefined>(() => roomText);
    const resolved = resolveAwarenessText(
      { editor, model, text: boundText },
      editor,
      model,
      fallback,
    );
    expect(resolved.text).toBe(boundText);
    expect(resolved.yMonacoRendersSelections).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the room's text when y-monaco binds another editor or model", () => {
    for (const binding of [
      null,
      { editor: {}, model, text: boundText },
      { editor, model: {}, text: boundText },
    ]) {
      const resolved = resolveAwarenessText(binding, editor, model, () => roomText);
      expect(resolved.text).toBe(roomText);
      expect(resolved.yMonacoRendersSelections).toBe(false);
    }
  });
});

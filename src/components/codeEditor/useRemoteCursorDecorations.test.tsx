import { renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vite-plus/test";
import { collaborationParticipantKey } from "../../collaboration/participantKey";
import { getCollaborationTexts } from "../../collaboration/projectDocument";
import { createCollaborationCursor } from "../../collaboration/relativePosition";
import type {
  CollaborationParticipant,
  useOptionalCollaboration,
} from "../../contexts/CollaborationContext";
import type { monaco } from "../../monaco";

// The real "../../monaco" loads the whole editor. Decorations only construct
// ranges and name the label positions, so plain stand-ins do.
vi.mock("../../monaco", () => {
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
  return {
    monaco: { Range, editor: { ContentWidgetPositionPreference: { ABOVE: 1, BELOW: 2 } } },
  };
});

import { useRemoteCursorDecorations } from "./useRemoteCursorDecorations";

type Collaboration = NonNullable<ReturnType<typeof useOptionalCollaboration>>;
type Props = Parameters<typeof useRemoteCursorDecorations>[0];

const CONTENT = "const a = 1;";

/**
 * A Monaco editor showing CONTENT that records the decorations it is given
 * and the name labels added to and removed from it.
 */
function fakeEditor() {
  return {
    getModel: () => ({
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    }),
    deltaDecorations: vi.fn<(old: string[], next: unknown[]) => string[]>((_old, next) =>
      next.map((_, index) => `d${index}`),
    ),
    addContentWidget: vi.fn<(widget: { getId(): string }) => void>(),
    layoutContentWidget: () => {},
    removeContentWidget: vi.fn<(widget: { getId(): string }) => void>(),
  };
}

const doc = new Y.Doc();
getCollaborationTexts(doc).set("file-1", new Y.Text(CONTENT));

const ADA: CollaborationParticipant = {
  kind: "state",
  roomId: "20000000-0000-4000-8000-000000000001",
  actorId: "30000000-0000-4000-8000-000000000002",
  sessionId: "40000000-0000-4000-8000-000000000002",
  revision: 1,
  role: "editor",
  username: "ada",
  name: "Ada",
  avatarUrl: null,
  isHost: false,
  surface: { kind: "editor", fileNodeId: "file-1", viewport: null },
  cursor: createCollaborationCursor(doc, "file-1", 6, 6),
  occurredAt: 1,
  expiresAt: 2,
};

/** A live room with Ada's caret at offset 6 of the open file. */
const ROOM = {
  provider: { doc, awareness: { clientID: 1, getStates: () => new Map() } },
  doc,
  participants: [ADA],
  ownParticipantKey: null,
  getNodeIdForPath: (path: string) => (path === "main.ts" ? "file-1" : null),
} as unknown as Collaboration;

function props(editor: ReturnType<typeof fakeEditor>, collaboration: Collaboration | null): Props {
  return {
    editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
    collaboration,
    activeFilePath: "main.ts",
    getYMonacoBinding: () => null,
  };
}

describe("useRemoteCursorDecorations", () => {
  it("draws another participant's caret with a name label", () => {
    const editor = fakeEditor();
    renderHook(useRemoteCursorDecorations, { initialProps: props(editor, ROOM) });

    expect(editor.deltaDecorations.mock.calls.at(-1)?.[1]).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 7 },
        options: {
          beforeContentClassName: expect.stringMatching(/^collaboration-cursor /),
          hoverMessage: { value: "Ada" },
        },
      },
    ]);
    expect(editor.addContentWidget.mock.calls.map(([widget]) => widget.getId())).toEqual([
      `next-editor.collaboration-cursor-label:${collaborationParticipantKey(ADA)}`,
    ]);
  });

  it("removes the decorations and labels once there is no room", () => {
    const editor = fakeEditor();
    const { rerender } = renderHook(useRemoteCursorDecorations, {
      initialProps: props(editor, ROOM),
    });

    rerender(props(editor, null));

    expect(editor.deltaDecorations.mock.calls.at(-1)?.[1]).toEqual([]);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
  });

  it("clears the labels when asked to, for the editor's unmount", () => {
    const editor = fakeEditor();
    const { result } = renderHook(useRemoteCursorDecorations, {
      initialProps: props(editor, ROOM),
    });

    result.current.clear();

    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
  });
});

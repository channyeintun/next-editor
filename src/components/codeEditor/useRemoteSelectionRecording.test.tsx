import { renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vite-plus/test";
import { getCollaborationTexts } from "../../collaboration/projectDocument";
import { createCollaborationCursor } from "../../collaboration/relativePosition";
import type {
  CollaborationParticipant,
  useOptionalCollaboration,
} from "../../contexts/CollaborationContext";
import type { monaco } from "../../monaco";

// The real "../../monaco" loads the whole editor; recording only reads positions.
vi.mock("../../monaco", () => ({ monaco: {} }));

import { useRemoteSelectionRecording } from "./useRemoteSelectionRecording";

type Collaboration = NonNullable<ReturnType<typeof useOptionalCollaboration>>;
type Props = Parameters<typeof useRemoteSelectionRecording>[0];

// Line 1 is "const a = 1;" (offsets 0–12), line 2 is "const b = 2;" (13–25).
const CONTENT = "const a = 1;\nconst b = 2;";
const ACTIVE_FILE = { path: "main.ts", content: CONTENT };

/** Just enough of a Monaco editor showing CONTENT to place offsets. */
const editor = {
  getModel: () => ({
    getPositionAt(offset: number) {
      const lines = CONTENT.slice(0, Math.max(0, Math.min(offset, CONTENT.length))).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 };
    },
  }),
} as unknown as monaco.editor.IStandaloneCodeEditor;

const doc = new Y.Doc();
getCollaborationTexts(doc).set("file-1", new Y.Text(CONTENT));
const provider = {
  doc,
  awareness: { clientID: 1, getStates: () => new Map() },
} as unknown as Collaboration["provider"];

function person(
  name: string,
  sessionDigit: string,
  role: CollaborationParticipant["role"] = "editor",
): CollaborationParticipant {
  return {
    kind: "state",
    roomId: "20000000-0000-4000-8000-000000000001",
    actorId: "30000000-0000-4000-8000-000000000002",
    sessionId: `40000000-0000-4000-8000-00000000000${sessionDigit}`,
    revision: 1,
    role,
    username: name.toLowerCase(),
    name,
    avatarUrl: null,
    isHost: false,
    surface: { kind: "editor", fileNodeId: "file-1", viewport: null },
    cursor: null,
    occurredAt: 1,
    expiresAt: 2,
  };
}

/** `who` with a caret or selection in the open file, published at `occurredAt`. */
function at(
  who: CollaborationParticipant,
  anchorOffset: number,
  headOffset: number,
  occurredAt = 1,
): CollaborationParticipant {
  return {
    ...who,
    occurredAt,
    cursor: createCollaborationCursor(doc, "file-1", anchorOffset, headOffset),
  };
}

const getNodeIdForPath = vi.fn<(path: string) => string | null>((path) =>
  path === ACTIVE_FILE.path ? "file-1" : null,
);

function props(participants: CollaborationParticipant[], overrides: Partial<Props> = {}): Props {
  return {
    editorRef: { current: editor },
    collaboration: {
      provider,
      doc,
      getNodeIdForPath,
    } as unknown as Collaboration,
    presence: {
      participants,
      ownParticipantKey: null,
      followedParticipantKey: null,
      followedParticipant: null,
      surfaceRepublishVersion: 0,
    },
    activeFile: ACTIVE_FILE,
    usesPlaybackModel: false,
    isRecording: true,
    handleEditorChange: vi.fn<Props["handleEditorChange"]>(),
    getYMonacoBinding: () => null,
    ...overrides,
  };
}

const ada = person("Ada", "2");
const grace = person("Grace", "3");

describe("useRemoteSelectionRecording", () => {
  it("resolves and records nothing outside a take", () => {
    getNodeIdForPath.mockClear();
    const handleEditorChange = vi.fn<Props["handleEditorChange"]>();
    const { rerender } = renderHook(useRemoteSelectionRecording, {
      initialProps: props([at(ada, 0, 0)], { isRecording: false, handleEditorChange }),
    });
    for (const offset of [1, 2, 3]) {
      rerender(props([at(ada, offset, offset)], { isRecording: false, handleEditorChange }));
    }

    expect(getNodeIdForPath).not.toHaveBeenCalled();
    expect(handleEditorChange).not.toHaveBeenCalled();
  });

  it("takes a baseline on the take's first run, then records a selection that moved", () => {
    const handleEditorChange = vi.fn<Props["handleEditorChange"]>();
    const { rerender } = renderHook(useRemoteSelectionRecording, {
      initialProps: props([at(ada, 0, 0)], { isRecording: false, handleEditorChange }),
    });

    rerender(props([at(ada, 0, 0)], { handleEditorChange }));
    expect(handleEditorChange).not.toHaveBeenCalled();

    rerender(props([at(ada, 19, 6)], { handleEditorChange }));
    expect(handleEditorChange.mock.calls).toEqual([
      [
        {
          startLineNumber: 1,
          startColumn: 7,
          endLineNumber: 2,
          endColumn: 7,
          selectionStartLineNumber: 2,
          selectionStartColumn: 7,
          positionLineNumber: 1,
          positionColumn: 7,
        },
      ],
    ]);
  });

  it("records only the most recent of the selections that moved", () => {
    const handleEditorChange = vi.fn<Props["handleEditorChange"]>();
    const { rerender } = renderHook(useRemoteSelectionRecording, {
      initialProps: props([at(ada, 0, 0), at(grace, 0, 0)], { handleEditorChange }),
    });

    rerender(props([at(ada, 4, 4, 5), at(grace, 13, 13, 9)], { handleEditorChange }));

    expect(handleEditorChange).toHaveBeenCalledTimes(1);
    expect(handleEditorChange.mock.calls[0][0]).toMatchObject({
      positionLineNumber: 2,
      positionColumn: 1,
    });
  });

  it("never records a viewer's selection", () => {
    const viewer = person("Linus", "4", "viewer");
    const handleEditorChange = vi.fn<Props["handleEditorChange"]>();
    const { rerender } = renderHook(useRemoteSelectionRecording, {
      initialProps: props([at(viewer, 0, 0)], { handleEditorChange }),
    });

    rerender(props([at(viewer, 4, 8)], { handleEditorChange }));

    expect(handleEditorChange).not.toHaveBeenCalled();
  });
});

import { render } from "@testing-library/react";
import * as Y from "yjs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getCollaborationTexts } from "../collaboration/projectDocument";
import { createCollaborationCursor } from "../collaboration/relativePosition";
import type {
  CollaborationParticipant,
  useOptionalCollaboration,
} from "../contexts/CollaborationContext";

type Collaboration = NonNullable<ReturnType<typeof useOptionalCollaboration>>;
type Listener = (...args: unknown[]) => void;

// What the mocked modules below hand CodeEditor. A test sets these and
// re-renders; the mocks read them on every render.
const harness = vi.hoisted(() => ({
  collaboration: null as unknown,
  isRecording: false,
  editor: null as unknown,
  model: null as unknown,
  actions: null as unknown,
}));

// Monaco itself is not under test. The editor view mounts the way
// MonacoEditor does, calling onMount exactly once from a mount-only layout
// effect, with the fake editor the test built.
vi.mock("../monaco", async () => {
  const { useLayoutEffect } = await import("react");
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
    monaco: {
      KeyCode: { Escape: 9 },
      SelectionDirection: { LTR: 0, RTL: 1 },
      Range,
      editor: {
        ContentWidgetPositionPreference: { EXACT: 0, ABOVE: 1, BELOW: 2 },
        ScrollType: { Smooth: 0, Immediate: 1 },
      },
    },
    MonacoEditor: ({ onMount }: { onMount?: (editor: unknown) => void }) => {
      useLayoutEffect(() => {
        onMount?.(harness.editor);
      }, []);
      return null;
    },
    getEditorOptions: () => ({}),
    syncWorkspaceModel: () => harness.model,
    getOrCreatePlaybackModel: () => harness.model,
    acknowledgeWorkspaceModelContent: () => {},
    disposePlaybackModels: () => {},
    disposeRemovedWorkspaceModels: () => [],
    isPlaybackModelUri: () => false,
    toMonacoModelPath: (path: string) => path,
    toPlaybackModelPath: (path: string) => path,
    workspacePathFromMonacoModelUri: () => "index.html",
  };
});

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => harness.actions,
  useNextEditorMetadata: () => ({
    currentRecording: null,
    isPlaying: false,
    isRecording: harness.isRecording,
    usesPlaybackModel: false,
  }),
}));

const ACTIVE_FILE = { path: "index.html", content: "<p>hi</p>", language: "html" };
const workspaceActions = {
  applyFileTextEdits: () => null,
  getProject: () => ({ files: {} }),
  saveProject: async () => {},
  updateFileContent: () => {},
};
vi.mock("../hooks/useWorkspace", () => ({
  useWorkspaceActions: () => workspaceActions,
  useWorkspaceEditorState: () => ({ activeFile: ACTIVE_FILE }),
  useWorkspaceLessonType: () => "html-css",
  useWorkspaceTreeVersion: () => 0,
}));
vi.mock("../hooks/useWebContainerRuntime", () => ({
  useWebContainerRuntimeSaveWorkspace: () => async () => {},
}));
vi.mock("../hooks/useRuntimeDockLayout", () => ({
  useRuntimeDockLayout: () => ({ displayIsCollapsed: false, displayIsFullHeight: false }),
}));
vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => harness.collaboration,
}));
vi.mock("../contexts/SlidesContext", () => ({
  useSlidesContext: () => ({ previewState: { isOpen: false } }),
}));
vi.mock("../contexts/WhiteboardContext", () => ({
  useWhiteboardContext: () => ({ isOpen: false }),
}));

// The panels around the editor are not under test.
vi.mock("./EditorHeader", () => ({ default: () => null }));
vi.mock("./FileSidebar", () => ({ default: () => null }));
vi.mock("./WorkspaceEventRecorder", () => ({ WorkspaceEventRecorder: () => null }));
vi.mock("./BinaryFilePreview", () => ({ default: () => null }));
vi.mock("./Preview", () => ({ default: () => null }));
vi.mock("./TerminalPanel", () => ({ default: () => null }));
vi.mock("./GoPlaygroundRunnerPanel", () => ({ default: () => null }));
vi.mock("./KotlinPlaygroundRunnerPanel", () => ({ default: () => null }));
vi.mock("./RustPlaygroundRunnerPanel", () => ({ default: () => null }));
vi.mock("./ZigPlaygroundRunnerPanel", () => ({ default: () => null }));
vi.mock("./HaskellPlaygroundRunnerPanel", () => ({ default: () => null }));
vi.mock("./KitePlaygroundRunnerPanel", () => ({ default: () => null }));
vi.mock("./AsmPlaygroundRunnerPanel", () => ({ default: () => null }));

const { default: CodeEditor } = await import("./CodeEditor");

/** A Monaco model over `text`, with just what CodeEditor reads of one. */
function fakeModel(text: string) {
  return {
    uri: { toString: () => "file:///index.html" },
    getVersionId: () => 1,
    getValue: () => text,
    getValueLength: () => text.length,
    isDisposed: () => false,
    getOffsetAt: ({ lineNumber, column }: { lineNumber: number; column: number }) =>
      text
        .split("\n")
        .slice(0, lineNumber - 1)
        .join("\n").length +
      (lineNumber > 1 ? 1 : 0) +
      column -
      1,
    getPositionAt(offset: number) {
      const lines = text.slice(0, Math.max(0, Math.min(offset, text.length))).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 };
    },
  };
}

/**
 * A Monaco editor that records the listeners CodeEditor registers on it, by
 * event name, so a test can see which exist and fire them.
 */
function fakeEditor(model: ReturnType<typeof fakeModel>) {
  const listeners = new Map<string, Listener[]>();
  const domNode = document.createElement("div");
  const on = (name: string) => (listener: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    return { dispose: () => {} };
  };
  return {
    listeners,
    domNode,
    fire(name: string, ...args: unknown[]) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    getModel: () => model,
    getDomNode: () => domNode,
    getSelection: () => null,
    getVisibleRanges: () => [],
    focus: () => {},
    saveViewState: () => null,
    restoreViewState: () => {},
    updateOptions: () => {},
    addAction: () => ({ dispose: () => {} }),
    addContentWidget: vi.fn<(widget: { getId(): string }) => void>(),
    layoutContentWidget: () => {},
    removeContentWidget: vi.fn<(widget: { getId(): string }) => void>(),
    deltaDecorations: vi.fn<(old: string[], next: unknown[]) => string[]>((_old, next) =>
      next.map((_, index) => `d${index}`),
    ),
    onDidChangeModel: on("onDidChangeModel"),
    onDidChangeModelContent: on("onDidChangeModelContent"),
    onDidChangeCursorPosition: on("onDidChangeCursorPosition"),
    onDidChangeCursorSelection: on("onDidChangeCursorSelection"),
    onDidScrollChange: on("onDidScrollChange"),
    onDidBlurEditorText: on("onDidBlurEditorText"),
  };
}

/** A collaboration context value outside any room, with `overrides` applied. */
function fakeCollaboration(overrides: Partial<Collaboration> = {}): Collaboration {
  return {
    provider: null,
    doc: null,
    connectionState: "idle",
    canWrite: false,
    participants: [],
    ownParticipantKey: null,
    followedParticipantKey: null,
    followedParticipant: null,
    getNodeIdForPath: () => null,
    stopFollowing: vi.fn<Collaboration["stopFollowing"]>(),
    queueLocalTextEdit: vi.fn<Collaboration["queueLocalTextEdit"]>(),
    updateCursor: vi.fn<Collaboration["updateCursor"]>(),
    publishSurface: vi.fn<Collaboration["publishSurface"]>(),
    runFollowApplication: (application: () => void) => application(),
    ...overrides,
  } as Collaboration;
}

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
  surface: { kind: "editor", fileNodeId: null, viewport: null },
  cursor: null,
  occurredAt: 1,
  expiresAt: 2,
};

/**
 * A live room whose shared copy of the open file matches it, with one remote
 * editor, Ada. Returns the context value with Ada's cursor at given offsets.
 */
function roomWithAda() {
  const doc = new Y.Doc();
  getCollaborationTexts(doc).set("file-1", new Y.Text(ACTIVE_FILE.content));
  const provider = {
    doc,
    awareness: { clientID: 1, getStates: () => new Map(), setLocalStateField: () => {} },
    flushNow: async () => {},
  } as unknown as Collaboration["provider"];
  const getNodeIdForPath = (path: string) => (path === ACTIVE_FILE.path ? "file-1" : null);
  let revision = 0;
  return (anchorOffset: number, headOffset: number) => {
    revision += 1;
    return fakeCollaboration({
      provider,
      doc,
      connectionState: "live",
      getNodeIdForPath,
      participants: [
        {
          ...ADA,
          revision,
          occurredAt: revision,
          cursor: createCollaborationCursor(doc, "file-1", anchorOffset, headOffset),
        },
      ],
    });
  };
}

let editor: ReturnType<typeof fakeEditor>;
let handleEditorChange: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

beforeEach(() => {
  const model = fakeModel(ACTIVE_FILE.content);
  editor = fakeEditor(model);
  handleEditorChange = vi.fn<(...args: unknown[]) => void>();
  harness.model = model;
  harness.editor = editor;
  harness.isRecording = false;
  harness.collaboration = fakeCollaboration();
  harness.actions = {
    syncEditorRef: () => {},
    handleEditorChange,
    handleWorkspaceEvent: () => {},
    editorRef: { current: null },
  };
});

describe("CodeEditor's Monaco listeners", () => {
  it("flushes edits on blur to a room joined after the editor mounted", () => {
    const { rerender } = render(<CodeEditor />);

    const flushNow = vi.fn<() => Promise<void>>(async () => {});
    harness.collaboration = fakeCollaboration({
      provider: { flushNow } as unknown as Collaboration["provider"],
    });
    rerender(<CodeEditor />);
    editor.fire("onDidBlurEditorText");

    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it("stops following in a room joined after the editor mounted", () => {
    const { rerender } = render(<CodeEditor />);

    const stopFollowing = vi.fn<Collaboration["stopFollowing"]>();
    harness.collaboration = fakeCollaboration({ stopFollowing });
    rerender(<CodeEditor />);
    editor.domNode.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    editor.domNode.dispatchEvent(new WheelEvent("wheel"));

    expect(stopFollowing.mock.calls).toEqual([["local-editor-input"], ["local-scroll"]]);
  });

  it("captures a cursor-state change once, from the selection event", () => {
    render(<CodeEditor />);
    expect(editor.listeners.has("onDidChangeCursorSelection")).toBe(true);
    expect(editor.listeners.has("onDidChangeCursorPosition")).toBe(false);

    // Monaco fires both events, back to back, for one caret move.
    editor.fire("onDidChangeCursorPosition");
    editor.fire("onDidChangeCursorSelection");

    expect(handleEditorChange).toHaveBeenCalledTimes(1);
  });
});

describe("CodeEditor's remote cursors", () => {
  it("draws another participant's selection, caret and name label", () => {
    harness.collaboration = roomWithAda()(2, 4);
    render(<CodeEditor />);

    const decorations = editor.deltaDecorations.mock.calls.at(-1)?.[1];
    expect(decorations).toEqual([
      expect.objectContaining({
        range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 5 },
        options: expect.objectContaining({ hoverMessage: { value: "Ada" } }),
      }),
      expect.objectContaining({
        range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 5 },
        options: expect.objectContaining({ hoverMessage: { value: "Ada" } }),
      }),
    ]);
    expect(editor.addContentWidget.mock.calls.map(([widget]) => widget.getId())).toEqual([
      "next-editor.collaboration-cursor-label:30000000-0000-4000-8000-000000000002:40000000-0000-4000-8000-000000000002",
    ]);
  });

  it("clears them when the room goes away", () => {
    harness.collaboration = roomWithAda()(2, 4);
    const { rerender } = render(<CodeEditor />);

    harness.collaboration = fakeCollaboration();
    rerender(<CodeEditor />);

    expect(editor.deltaDecorations.mock.calls.at(-1)?.[1]).toEqual([]);
    expect(editor.removeContentWidget).toHaveBeenCalledTimes(1);
  });
});

describe("CodeEditor's remote selection recording", () => {
  it("records a remote cursor only during a take, from its second run on", () => {
    const adaAt = roomWithAda();
    harness.collaboration = adaAt(0, 0);
    const { rerender } = render(<CodeEditor />);
    for (const offset of [1, 2, 3]) {
      harness.collaboration = adaAt(offset, offset);
      rerender(<CodeEditor />);
    }
    expect(handleEditorChange).not.toHaveBeenCalled();

    // The take's first run only takes the baseline.
    harness.isRecording = true;
    rerender(<CodeEditor />);
    expect(handleEditorChange).not.toHaveBeenCalled();

    harness.collaboration = adaAt(2, 4);
    rerender(<CodeEditor />);
    expect(handleEditorChange.mock.calls).toEqual([
      [
        {
          startLineNumber: 1,
          startColumn: 3,
          endLineNumber: 1,
          endColumn: 5,
          selectionStartLineNumber: 1,
          selectionStartColumn: 3,
          positionLineNumber: 1,
          positionColumn: 5,
        },
      ],
    ]);
  });
});

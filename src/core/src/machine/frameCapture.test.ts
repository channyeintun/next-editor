import { describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorSelection, MouseCursorPosition } from "../types";
import { normalizeEditorFrame } from "../utils/editorState";
import { createFrame } from "./frameCapture";

interface FakeEditorState {
  uri: string;
  /** The model instance's `id`; defaults to the uri (one model per file). */
  modelId?: string;
  versionId: number;
  value: string;
  scrollTop: number;
  position?: monaco.IPosition | null;
  selection?: monaco.ISelection | null;
  viewState?: monaco.editor.ICodeEditorViewState | null;
}

const makeEditor = (state: FakeEditorState) => {
  const getValue = vi.fn<() => string>(() => state.value);
  const saveViewState = vi.fn<() => monaco.editor.ICodeEditorViewState | null>(
    () => state.viewState ?? null,
  );
  const editor = {
    getModel: () => ({
      id: state.modelId ?? state.uri,
      getVersionId: () => state.versionId,
      uri: { toString: () => state.uri },
    }),
    getValue,
    getPosition: () => state.position ?? null,
    getSelection: () => state.selection ?? null,
    getScrollTop: () => state.scrollTop,
    getScrollLeft: () => 0,
    saveViewState,
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  return { editor, getValue, saveViewState, state };
};

const mouse: MouseCursorPosition = { x: 0, y: 0, visible: false };

/** What a capture hands the next one: its content string and view state. */
const previousOf = ({ frame, viewStateRef }: ReturnType<typeof createFrame>) => ({
  content: {
    value: frame.state.content,
    versionId: viewStateRef.versionId,
    modelId: viewStateRef.modelId,
  },
  viewState: viewStateRef,
});

describe("createFrame capture gating", () => {
  it("reuses content and viewState by reference when model, version, scroll and selection are unchanged", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(second.frame.state.content).toBe(first.frame.state.content);
    expect(fake.getValue).toHaveBeenCalledTimes(1);
    expect(fake.saveViewState).toHaveBeenCalledTimes(1);
    expect(second.frame.state.viewState).toBe(first.frame.state.viewState);
  });

  it("does not reuse content when the model changed, even if the per-model version id coincides", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    // Simulate switching the active file: new model, same numeric version id.
    fake.state.uri = "file:///b.ts";
    fake.state.modelId = "$model2";
    fake.state.value = "bbb";

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(second.frame.state.content).toBe("bbb");
    expect(second.viewStateRef.modelId).toBe("$model2");
    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
  });

  it("does not reuse content from a removed file's model when a new model takes its uri", () => {
    const fake = makeEditor({
      uri: "file:///a.ts",
      modelId: "$model1",
      versionId: 1,
      value: "old",
      scrollTop: 0,
    });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    // The file is removed and re-created: a new model under the same uri, whose
    // version id starts over at 1.
    fake.state.modelId = "$model2";
    fake.state.value = "new";

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(fake.getValue).toHaveBeenCalledTimes(2);
    expect(second.frame.state.content).toBe("new");
    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
  });

  it("recomputes viewState when scroll changes but still reuses unchanged content", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, { timestamp: 0, mouseCursor: mouse });

    fake.state.scrollTop = 120;

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: previousOf(first),
    });

    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
    expect(second.frame.state.content).toBe(first.frame.state.content);
    expect(fake.getValue).toHaveBeenCalledTimes(1);
  });

  it("captures a remote selection without changing the local editor cursor", () => {
    const localSelection: EditorSelection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    };
    const remoteSelection: EditorSelection = {
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 6,
      selectionStartLineNumber: 4,
      selectionStartColumn: 6,
      positionLineNumber: 2,
      positionColumn: 3,
    };
    const fake = makeEditor({
      uri: "file:///a.ts",
      versionId: 6,
      value: "one\ntwo\nthree\nfour",
      scrollTop: 0,
      position: { lineNumber: 1, column: 1 },
      selection: localSelection,
      viewState: {
        cursorState: [
          {
            inSelectionMode: false,
            selectionStart: { lineNumber: 1, column: 1 },
            position: { lineNumber: 1, column: 1 },
          },
        ],
        viewState: {
          scrollTop: 0,
          scrollTopWithoutViewZones: 0,
          scrollLeft: 0,
          firstPosition: { lineNumber: 1, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      },
    });

    const captured = createFrame(fake.editor, {
      timestamp: 25,
      mouseCursor: mouse,
      selectionOverride: remoteSelection,
    });
    const normalized = normalizeEditorFrame(captured.frame);

    expect(normalized.state.selection).toEqual(remoteSelection);
    expect(normalized.state.position).toEqual({ lineNumber: 2, column: 3 });
    expect(
      (normalized.state.viewState as unknown as { cursorState: unknown[] }).cursorState[0],
    ).toMatchObject({
      inSelectionMode: true,
      selectionStart: { lineNumber: 4, column: 6 },
      position: { lineNumber: 2, column: 3 },
      selection: remoteSelection,
    });
    expect(fake.state.position).toEqual({ lineNumber: 1, column: 1 });
    expect(fake.state.selection).toEqual(localSelection);
  });

  it("does not rewrite the previous frame's view state when a remote selection repeats", () => {
    const remoteSelection: EditorSelection = {
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 4,
      selectionStartLineNumber: 1,
      selectionStartColumn: 2,
      positionLineNumber: 1,
      positionColumn: 4,
    };
    const fake = makeEditor({
      uri: "file:///a.ts",
      versionId: 3,
      value: "abcdef",
      scrollTop: 0,
      position: { lineNumber: 1, column: 1 },
      viewState: {
        cursorState: [
          {
            inSelectionMode: false,
            selectionStart: { lineNumber: 1, column: 1 },
            position: { lineNumber: 1, column: 1 },
          },
        ],
        viewState: {
          scrollTop: 0,
          scrollTopWithoutViewZones: 0,
          scrollLeft: 0,
          firstPosition: { lineNumber: 1, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      },
    });
    const cursorStateOf = (viewState: unknown) =>
      (viewState as { cursorState: Array<Record<string, unknown>> }).cursorState;

    const first = createFrame(fake.editor, {
      timestamp: 0,
      mouseCursor: mouse,
      selectionOverride: remoteSelection,
    });
    const recordedCursor = cursorStateOf(first.frame.state.viewState)[0];
    const recordedCursorJson = JSON.stringify(recordedCursor);

    const second = createFrame(fake.editor, {
      timestamp: 50,
      mouseCursor: mouse,
      previous: { viewState: first.viewStateRef },
      selectionOverride: remoteSelection,
    });

    // The unchanged selection reuses the recorded view state, which must stay as recorded.
    expect(second.frame.state.viewState).toBe(first.frame.state.viewState);
    expect(cursorStateOf(first.frame.state.viewState)[0]).toBe(recordedCursor);
    expect(JSON.stringify(recordedCursor)).toBe(recordedCursorJson);
    expect(recordedCursor).toMatchObject({ inSelectionMode: true, selection: remoteSelection });
  });
});

import { describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorSelection, MouseCursorPosition } from "../types";
import { normalizeEditorFrame } from "../utils/editorState";
import { createFrame } from "./editorMachineHelpers";

interface FakeEditorState {
  uri: string;
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

describe("createFrame capture gating", () => {
  it("reuses content and viewState by reference when model, version, scroll and selection are unchanged", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, 0, mouse);

    const second = createFrame(
      fake.editor,
      50,
      mouse,
      undefined,
      undefined,
      {
        value: first.frame.state.content,
        versionId: first.contentVersionId,
        modelUri: first.modelUri,
      },
      first.viewStateRef,
    );

    expect(second.frame.state.content).toBe(first.frame.state.content);
    expect(fake.getValue).toHaveBeenCalledTimes(1);
    expect(fake.saveViewState).toHaveBeenCalledTimes(1);
    expect(second.frame.state.viewState).toBe(first.frame.state.viewState);
  });

  it("does not reuse content when the model changed, even if the per-model version id coincides", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, 0, mouse);

    // Simulate switching the active file: new model, same numeric version id.
    fake.state.uri = "file:///b.ts";
    fake.state.value = "bbb";

    const second = createFrame(
      fake.editor,
      50,
      mouse,
      undefined,
      undefined,
      {
        value: first.frame.state.content,
        versionId: first.contentVersionId,
        modelUri: first.modelUri,
      },
      first.viewStateRef,
    );

    expect(second.frame.state.content).toBe("bbb");
    expect(second.modelUri).toBe("file:///b.ts");
    expect(fake.saveViewState).toHaveBeenCalledTimes(2);
  });

  it("recomputes viewState when scroll changes but still reuses unchanged content", () => {
    const fake = makeEditor({ uri: "file:///a.ts", versionId: 5, value: "aaa", scrollTop: 0 });
    const first = createFrame(fake.editor, 0, mouse);

    fake.state.scrollTop = 120;

    const second = createFrame(
      fake.editor,
      50,
      mouse,
      undefined,
      undefined,
      {
        value: first.frame.state.content,
        versionId: first.contentVersionId,
        modelUri: first.modelUri,
      },
      first.viewStateRef,
    );

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

    const captured = createFrame(
      fake.editor,
      25,
      mouse,
      undefined,
      undefined,
      undefined,
      undefined,
      remoteSelection,
    );
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
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorFrame } from "../types";
import { normalizeEditorFrame } from "./editorState";

const frameWithViewState = (): EditorFrame => ({
  timestamp: 0,
  state: {
    content: "abc",
    selection: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 3,
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 3,
    },
    position: { lineNumber: 1, column: 3 },
    viewState: {
      cursorState: [
        {
          inSelectionMode: true,
          selectionStart: { lineNumber: 1, column: 1 },
          position: { lineNumber: 1, column: 3 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    } as unknown as monaco.editor.ICodeEditorViewState,
  },
});

describe("normalizeEditorFrame", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Every replayed delta fold ends in normalizeEditorFrame, so each extra deep clone
  // of the view state is paid on every tick that crosses a frame.
  it("clones the view state once", () => {
    const frame = frameWithViewState();
    const clone = vi.spyOn(globalThis, "structuredClone");

    const normalized = normalizeEditorFrame(frame);

    expect(clone).toHaveBeenCalledTimes(1);
    expect(normalized.state.viewState).not.toBe(frame.state.viewState);
    expect(
      (normalized.state.viewState as unknown as { cursorState: unknown[] }).cursorState[0],
    ).toMatchObject({
      position: { lineNumber: 1, column: 3 },
      selection: frame.state.selection,
    });
  });
});

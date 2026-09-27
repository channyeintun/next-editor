import { describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorFrame, EditorSelection } from "../types";
import { applyFrameState } from "./replayActions";

describe("applyFrameState cursor", () => {
  // Monaco's selection carries the caret, so one setSelection is the whole cursor
  // write. A setPosition before it collapsed a non-empty selection first, costing a
  // second cursor update that the setSelection then overwrote.
  it("moves the caret and selection with one cursor write", () => {
    const content = "abcdef";
    let selection: monaco.ISelection = {
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 1,
      positionColumn: 1,
    };
    const setSelection = vi.fn<(next: monaco.ISelection) => void>((next) => {
      selection = next;
    });
    const setPosition = vi.fn<(position: monaco.IPosition) => void>((position) => {
      selection = {
        selectionStartLineNumber: position.lineNumber,
        selectionStartColumn: position.column,
        positionLineNumber: position.lineNumber,
        positionColumn: position.column,
      };
    });
    const editor = {
      getModel: () => ({
        getLineCount: () => 1,
        getLineLength: () => content.length,
        getValueLength: () => content.length,
      }),
      getSelection: () => ({
        startLineNumber: selection.selectionStartLineNumber,
        startColumn: Math.min(selection.selectionStartColumn, selection.positionColumn),
        endLineNumber: selection.positionLineNumber,
        endColumn: Math.max(selection.selectionStartColumn, selection.positionColumn),
        ...selection,
      }),
      getPosition: () => ({
        lineNumber: selection.positionLineNumber,
        column: selection.positionColumn,
      }),
      setSelection,
      setPosition,
      hasTextFocus: () => true,
    } as unknown as monaco.editor.IStandaloneCodeEditor;
    const target: EditorSelection = {
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 4,
      selectionStartLineNumber: 1,
      selectionStartColumn: 2,
      positionLineNumber: 1,
      positionColumn: 4,
    };
    const frameWith = (frameSelection: EditorSelection): EditorFrame => ({
      timestamp: 0,
      state: {
        content,
        selection: frameSelection,
        position: {
          lineNumber: frameSelection.positionLineNumber,
          column: frameSelection.positionColumn,
        },
        viewState: null,
      },
    });
    const previous = frameWith({
      ...target,
      startColumn: 1,
      endColumn: 1,
      selectionStartColumn: 1,
      positionColumn: 1,
    });

    applyFrameState(editor, frameWith(target), null, false, previous);

    expect(setPosition).not.toHaveBeenCalled();
    expect(setSelection).toHaveBeenCalledTimes(1);
    expect(selection).toMatchObject({
      selectionStartColumn: 2,
      positionColumn: 4,
    });

    // Already there: no cursor write at all.
    applyFrameState(editor, frameWith(target), null, false, frameWith(target));
    expect(setSelection).toHaveBeenCalledTimes(1);
  });
});

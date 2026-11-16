import { describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorFrame, EditorSelection } from "../types";
import { applyFrameState } from "./frameReplay";
import { isLearnerCaretHeld, trackLearnerCaret } from "./playbackCaret";

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

    applyFrameState(editor, frameWith(target), previous);

    expect(setPosition).not.toHaveBeenCalled();
    expect(setSelection).toHaveBeenCalledTimes(1);
    expect(selection).toMatchObject({
      selectionStartColumn: 2,
      positionColumn: 4,
    });

    // Already there: no cursor write at all.
    applyFrameState(editor, frameWith(target), frameWith(target));
    expect(setSelection).toHaveBeenCalledTimes(1);
  });

  // A learner who clicks into the code while the lesson plays keeps that caret
  // (playbackCaret.ts): what they type next, which pauses the lesson, must land there.
  it("follows the recorded view but leaves a caret the learner placed", () => {
    const caretAt = (line: number, column: number): EditorSelection => ({
      startLineNumber: line,
      startColumn: column,
      endLineNumber: line,
      endColumn: column,
      selectionStartLineNumber: line,
      selectionStartColumn: column,
      positionLineNumber: line,
      positionColumn: column,
    });
    let selection = caretAt(1, 1);
    const cursorListeners: ((event: { source: string }) => void)[] = [];
    const reportCursorChange = (source: string) => {
      for (const listener of cursorListeners) listener({ source });
    };
    // As in Monaco, each write reports the cursor change it causes before it returns.
    const setSelection = vi.fn<(next: EditorSelection) => void>((next) => {
      selection = next;
      reportCursorChange("api");
    });
    const restoreViewState = vi.fn<(state: monaco.editor.ICodeEditorViewState | null) => void>(
      (state) => {
        const cursor = state?.cursorState[0];
        if (!cursor) return;
        selection = caretAt(cursor.position.lineNumber, cursor.position.column);
        reportCursorChange("restoreState");
      },
    );
    const model = {
      getLineCount: () => 30,
      getLineLength: () => 80,
      getValueLength: () => 2400,
      getValue: () => "",
    };
    const editor = {
      getModel: () => model,
      getDomNode: () => null,
      getSelection: () => selection,
      getSelections: () => [selection],
      setSelection,
      restoreViewState,
      hasTextFocus: () => true,
      onDidChangeCursorSelection(listener: (event: { source: string }) => void) {
        cursorListeners.push(listener);
        return { dispose: () => {} };
      },
      onMouseDown: () => ({ dispose: () => {} }),
      onDidChangeModel: () => ({ dispose: () => {} }),
      createDecorationsCollection: () => ({ set: () => [], clear: () => {}, getRange: () => null }),
    } as unknown as monaco.editor.IStandaloneCodeEditor;
    const viewStateAt = (line: number): monaco.editor.ICodeEditorViewState => ({
      cursorState: [
        {
          inSelectionMode: false,
          selectionStart: { lineNumber: line, column: 1 },
          position: { lineNumber: line, column: 1 },
        },
      ],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: line, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    });
    const frameAt = (line: number): EditorFrame => ({
      timestamp: 0,
      state: {
        content: "",
        selection: caretAt(line, 1),
        position: { lineNumber: line, column: 1 },
        viewState: viewStateAt(line),
      },
    });
    const tracking = trackLearnerCaret(editor, () => true);

    // Replay's own writes move the cursor too, and are not the learner's: the caret
    // goes on following the recording.
    applyFrameState(editor, frameAt(3), null);
    expect(selection).toEqual(caretAt(3, 1));
    expect(restoreViewState).toHaveBeenLastCalledWith(viewStateAt(3));
    expect(isLearnerCaretHeld(editor)).toBe(false);
    applyFrameState(
      editor,
      { ...frameAt(3), state: { ...frameAt(3).state, selection: caretAt(3, 9) } },
      frameAt(3),
    );
    expect(selection).toEqual(caretAt(3, 9));
    expect(isLearnerCaretHeld(editor)).toBe(false);

    // The learner clicks on line 20, and the recording moves on to line 4.
    selection = caretAt(20, 7);
    reportCursorChange("mouse");
    expect(isLearnerCaretHeld(editor)).toBe(true);
    setSelection.mockClear();
    applyFrameState(editor, frameAt(4), frameAt(3));

    // The view scrolls with the recording; the cursor in it is not restored.
    expect(restoreViewState).toHaveBeenLastCalledWith({ ...viewStateAt(4), cursorState: [] });
    expect(setSelection).not.toHaveBeenCalled();
    expect(selection).toEqual(caretAt(20, 7));

    tracking.dispose();
  });
});

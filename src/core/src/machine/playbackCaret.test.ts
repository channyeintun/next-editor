import { describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorSelection } from "../types";
import {
  clearRecordedCaret,
  isLearnerCaretHeld,
  showRecordedCaret,
  trackLearnerCaret,
} from "./playbackCaret";

type Mark = monaco.editor.IModelDeltaDecoration;
type CursorListener = (event: { source: string }) => void;

/** A selection from `(startLine, startColumn)` to the caret at `(line, column)`. */
const selectionTo = (
  startLine: number,
  startColumn: number,
  line: number,
  column: number,
): EditorSelection => ({
  startLineNumber: startLine,
  startColumn,
  endLineNumber: line,
  endColumn: column,
  selectionStartLineNumber: startLine,
  selectionStartColumn: startColumn,
  positionLineNumber: line,
  positionColumn: column,
});

const caretAt = (line: number, column: number) => selectionTo(line, column, line, column);

/** A text model that keeps decorations by id, as Monaco's does. */
function fakeModel() {
  let nextId = 0;
  let disposed = false;
  const decorations = new Map<string, Mark>();
  const deltaDecorations = vi.fn<(oldIds: string[], next: Mark[]) => string[]>((oldIds, next) => {
    for (const id of oldIds) decorations.delete(id);
    return next.map((mark) => {
      const id = `mark-${nextId++}`;
      decorations.set(id, mark);
      return id;
    });
  });
  return {
    deltaDecorations,
    isDisposed: () => disposed,
    dispose() {
      disposed = true;
    },
    /** What is drawn: each mark's class and where its range starts and ends. */
    marks: () =>
      Array.from(decorations.values(), ({ range, options }) => [
        options.className,
        `${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}`,
      ]),
  };
}

/** An editor with one cursor, whose moves a test makes as replay or as the learner. */
function fakeEditor() {
  let selection = caretAt(1, 1);
  let focused = true;
  let model: ReturnType<typeof fakeModel> | null = fakeModel();
  const cursorListeners = new Set<CursorListener>();
  const modelListeners = new Set<() => void>();
  const setSelection = vi.fn<(next: EditorSelection) => void>((next) => {
    selection = next;
  });
  const editor = {
    setSelection,
    getSelection: () => selection,
    getSelections: () => [selection],
    getModel: () => model,
    hasTextFocus: () => focused,
    onDidChangeCursorSelection(listener: CursorListener) {
      cursorListeners.add(listener);
      return { dispose: () => cursorListeners.delete(listener) };
    },
    onDidChangeModel(listener: () => void) {
      modelListeners.add(listener);
      return { dispose: () => modelListeners.delete(listener) };
    },
  };
  return {
    editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
    setSelection,
    selection: () => selection,
    model: () => model!,
    blur() {
      focused = false;
    },
    /**
     * Swaps the model the editor shows, as a pause, a play or a replayed file switch
     * does. Monaco starts the new model with the caret on line 1.
     */
    show(next: ReturnType<typeof fakeModel>) {
      model = next;
      selection = caretAt(1, 1);
      for (const listener of modelListeners) listener();
    },
    /** Moves the cursor and reports the move with Monaco's `source` for it. */
    moveCaret(source: string, next: EditorSelection) {
      selection = next;
      for (const listener of cursorListeners) listener({ source });
    },
  };
}

const CARET = "playback-cursor-decoration";
const SELECTION = "playback-selection-decoration";

describe("the recorded caret", () => {
  it("is the editor's own caret while the editor has focus", () => {
    const fake = fakeEditor();

    showRecordedCaret(fake.editor, caretAt(3, 5));

    expect(fake.selection()).toEqual(caretAt(3, 5));
    // Monaco draws that caret itself: a mark would draw it twice.
    expect(fake.model().deltaDecorations).not.toHaveBeenCalled();
  });

  it("is marked while the editor has no focus, and the mark follows it", () => {
    const fake = fakeEditor();
    fake.blur();

    showRecordedCaret(fake.editor, caretAt(3, 5));
    expect(fake.model().marks()).toEqual([[CARET, "3:5-3:5"]]);

    showRecordedCaret(fake.editor, caretAt(4, 2));
    expect(fake.model().marks()).toEqual([[CARET, "4:2-4:2"]]);

    // Frames that leave the caret where it is redraw nothing.
    const draws = fake.model().deltaDecorations.mock.calls.length;
    showRecordedCaret(fake.editor, caretAt(4, 2));
    expect(fake.model().deltaDecorations).toHaveBeenCalledTimes(draws);
  });

  it("leaves its marks behind on a model the editor no longer shows", () => {
    const fake = fakeEditor();
    fake.blur();
    const playbackModel = fake.model();
    showRecordedCaret(fake.editor, caretAt(3, 5));

    const workspaceModel = fakeModel();
    fake.show(workspaceModel);
    showRecordedCaret(fake.editor, caretAt(3, 5));

    expect(playbackModel.marks()).toEqual([]);
    expect(workspaceModel.marks()).toEqual([[CARET, "3:5-3:5"]]);
  });

  it("is cleared with the lesson", () => {
    const fake = fakeEditor();
    fake.blur();
    showRecordedCaret(fake.editor, caretAt(3, 5));

    clearRecordedCaret(fake.editor);

    expect(fake.model().marks()).toEqual([]);
  });
});

describe("a caret the learner places while the lesson plays", () => {
  it("stays where they put it, with the recorded caret marked beside it", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    fake.setSelection.mockClear();

    // The learner clicks further down. The recorded caret is marked at once, without
    // waiting for the recording's next frame.
    fake.moveCaret("mouse", caretAt(20, 7));
    expect(isLearnerCaretHeld(fake.editor)).toBe(true);
    expect(fake.model().marks()).toEqual([[CARET, "3:5-3:5"]]);

    // The recording goes on: it selects a word, and the learner's caret does not move.
    showRecordedCaret(fake.editor, selectionTo(3, 5, 3, 11));
    expect(fake.setSelection).not.toHaveBeenCalled();
    expect(fake.selection()).toEqual(caretAt(20, 7));
    expect(fake.model().marks()).toEqual([
      [SELECTION, "3:5-3:11"],
      [CARET, "3:11-3:11"],
    ]);

    tracking.dispose();
  });

  it("is theirs after keyboard navigation too", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));

    fake.moveCaret("keyboard", caretAt(4, 5));

    expect(isLearnerCaretHeld(fake.editor)).toBe(true);
    tracking.dispose();
  });

  it.each(["api", "restoreState", "modelChange", "model"])(
    "is not taken from a cursor change replay made itself (%s)",
    (source) => {
      const fake = fakeEditor();
      const tracking = trackLearnerCaret(fake.editor, () => true);
      showRecordedCaret(fake.editor, caretAt(3, 5));

      fake.moveCaret(source, caretAt(3, 6));
      showRecordedCaret(fake.editor, caretAt(3, 7));

      expect(isLearnerCaretHeld(fake.editor)).toBe(false);
      expect(fake.selection()).toEqual(caretAt(3, 7));
      tracking.dispose();
    },
  );

  // The key that pauses a lesson is typed into the file handed over to the learner,
  // and moves the caret there before the tracking is disposed.
  it("is not taken once the lesson no longer plays", () => {
    const fake = fakeEditor();
    let playing = true;
    const tracking = trackLearnerCaret(fake.editor, () => playing);
    showRecordedCaret(fake.editor, caretAt(3, 5));

    playing = false;
    fake.moveCaret("keyboard", caretAt(3, 6));

    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    expect(fake.model().deltaDecorations).not.toHaveBeenCalled();
    tracking.dispose();
  });

  it("goes back to the recording when the recording opens another file", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    fake.moveCaret("mouse", caretAt(20, 7));

    // The caret the learner placed stayed in the file the editor left.
    fake.show(fakeModel());
    showRecordedCaret(fake.editor, caretAt(2, 4));

    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    expect(fake.selection()).toEqual(caretAt(2, 4));
    expect(fake.model().marks()).toEqual([]);
    tracking.dispose();
  });

  it("goes back to the recording when the lesson plays on", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    fake.moveCaret("mouse", caretAt(20, 7));
    fake.setSelection.mockClear();

    // The lesson pauses. Ending the tracking writes nothing: the editor may already
    // show the file handed over, with the caret the learner placed.
    tracking.dispose();
    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    expect(fake.setSelection).not.toHaveBeenCalled();
    expect(fake.selection()).toEqual(caretAt(20, 7));

    // It plays again: the editor's caret is the recording's once more, unmarked.
    showRecordedCaret(fake.editor, caretAt(3, 9));
    expect(fake.selection()).toEqual(caretAt(3, 9));
    expect(fake.model().marks()).toEqual([]);
  });
});

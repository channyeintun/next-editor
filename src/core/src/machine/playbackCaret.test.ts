import { describe, expect, it, vi } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { EditorSelection } from "../types";
import {
  asReplayWrite,
  clearCursorDecorations,
  clearRecordedCaret,
  isLearnerCaretHeld,
  releaseLearnerCaretHold,
  showRecordedCaret,
  trackLearnerCaret,
} from "./playbackCaret";
import type { EditorActionArgs } from "./types";

type Mark = monaco.editor.IModelDeltaDecoration;
type CursorListener = (event: { source: string }) => void;
type MouseListener = (event: { target: { type: number } }) => void;

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

// monaco.editor.MouseTargetType
const CONTENT_TEXT = 6;
const CONTENT_EMPTY = 7;
const GUTTER_LINE_NUMBERS = 3;
const SCROLLBAR = 11;

/**
 * A text model that keeps decorations by id with the editor that owns each, as Monaco's
 * does: every editor on the model draws them all, and an editor's own are removed when
 * it leaves the model or is disposed.
 */
function fakeModel() {
  let nextId = 0;
  const decorations = new Map<string, { owner: number; mark: Mark }>();
  return {
    deltaDecorations(owner: number, oldIds: readonly string[], next: readonly Mark[]) {
      for (const id of oldIds) decorations.delete(id);
      return next.map((mark) => {
        const id = `mark-${nextId++}`;
        decorations.set(id, { owner, mark });
        return id;
      });
    },
    removeAllDecorationsWithOwnerId(owner: number) {
      for (const [id, decoration] of decorations) {
        if (decoration.owner === owner) decorations.delete(id);
      }
    },
    getDecorationRange: (id: string) => decorations.get(id)?.mark.range ?? null,
    /** What any editor on the model draws: each mark's class and range. */
    marks: () =>
      Array.from(decorations.values(), ({ mark: { range, options } }) => [
        options.className,
        `${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}`,
      ]),
  };
}

let nextEditorId = 1;

/** An editor with one cursor, whose moves a test makes as replay or as the learner. */
function fakeEditor(initialModel = fakeModel()) {
  const id = nextEditorId++;
  let selection = caretAt(1, 1);
  let focused = true;
  let model: ReturnType<typeof fakeModel> | null = initialModel;
  const cursorListeners = new Set<CursorListener>();
  const mouseListeners = new Set<MouseListener>();
  const modelListeners = new Set<() => void>();
  const domNode = document.createElement("div");
  const draws = vi.fn<(marks: readonly Mark[]) => void>();
  const reportCursorChange = (source: string) => {
    for (const listener of cursorListeners) listener({ source });
  };
  // Monaco reports the cursor change a write causes before the write returns.
  const setSelection = vi.fn<(next: EditorSelection) => void>((next) => {
    selection = next;
    reportCursorChange("api");
  });
  const subscribe =
    <T>(listeners: Set<T>) =>
    (listener: T) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };
  const editor = {
    setSelection,
    getSelection: () => selection,
    getSelections: () => [selection],
    getModel: () => model,
    getDomNode: () => domNode,
    hasTextFocus: () => focused,
    onDidChangeCursorSelection: subscribe(cursorListeners),
    onMouseDown: subscribe(mouseListeners),
    onDidChangeModel: subscribe(modelListeners),
    // An editor's decorations collection: its marks are owned by this editor.
    createDecorationsCollection(initial: readonly Mark[] = []) {
      let ids: string[] = [];
      const collection = {
        set(marks: readonly Mark[]) {
          draws(marks);
          if (model) ids = model.deltaDecorations(id, ids, marks);
          return ids;
        },
        clear() {
          if (ids.length > 0) collection.set([]);
        },
        getRange: (index: number) =>
          model && index < ids.length ? model.getDecorationRange(ids[index]) : null,
      };
      if (initial.length > 0) collection.set(initial);
      return collection;
    },
  };
  return {
    editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
    setSelection,
    /** Each time the editor's decorations were rewritten. */
    draws,
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
      model?.removeAllDecorationsWithOwnerId(id);
      model = next;
      selection = caretAt(1, 1);
      for (const listener of modelListeners) listener();
    },
    /** Disposes the editor, as showing an image in its place does. The model lives on. */
    dispose() {
      model?.removeAllDecorationsWithOwnerId(id);
      model = null;
    },
    /** Moves the cursor and reports the move with Monaco's `source` for it. */
    moveCaret(source: string, next: EditorSelection) {
      selection = next;
      reportCursorChange(source);
    },
    /** A press on the editor that moves no cursor (it is already there). */
    pressOn(target: number) {
      for (const listener of mouseListeners) listener({ target: { type: target } });
    },
    /** A finger tap on the text: Monaco's own event, which never reaches onMouseDown. */
    tap() {
      domNode.dispatchEvent(new Event("-monaco-gesturetap"));
    },
    /**
     * Presses a key in the editor. `command` is what Monaco runs for it, within the
     * same keydown, as it does for a key bound to a cursor command.
     */
    pressKey(key: string, command?: () => void) {
      const inner = domNode.appendChild(document.createElement("textarea"));
      inner.addEventListener("keydown", () => command?.());
      inner.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      inner.remove();
    },
  };
}

/** The part of a machine action's arguments the caret actions read. */
const actionArgsFor = (editor: monaco.editor.IStandaloneCodeEditor | null) =>
  ({ context: { editorRefs: { editor } } }) as unknown as EditorActionArgs;

const CARET = "playback-cursor-decoration";
const DIMMED_CARET = "playback-cursor-decoration playback-cursor-decoration--beside-learner";
const SELECTION = "playback-selection-decoration";

describe("the recorded caret", () => {
  it("is the editor's own caret while the editor has focus", () => {
    const fake = fakeEditor();

    showRecordedCaret(fake.editor, caretAt(3, 5));

    expect(fake.selection()).toEqual(caretAt(3, 5));
    // Monaco draws that caret itself: a mark would draw it twice.
    expect(fake.draws).not.toHaveBeenCalled();
  });

  it("is marked while the editor has no focus, and the mark follows it", () => {
    const fake = fakeEditor();
    fake.blur();

    showRecordedCaret(fake.editor, caretAt(3, 5));
    expect(fake.model().marks()).toEqual([[CARET, "3:5-3:5"]]);

    showRecordedCaret(fake.editor, caretAt(4, 2));
    expect(fake.model().marks()).toEqual([[CARET, "4:2-4:2"]]);

    // Frames that leave the caret where it is redraw nothing.
    const draws = fake.draws.mock.calls.length;
    showRecordedCaret(fake.editor, caretAt(4, 2));
    expect(fake.draws).toHaveBeenCalledTimes(draws);
  });

  it("is drawn again on a model the editor comes to, and on one it comes back to", () => {
    const fake = fakeEditor();
    fake.blur();
    const playbackModel = fake.model();
    showRecordedCaret(fake.editor, caretAt(3, 5));

    // The lesson hands the file over: Monaco took the marks off the model it left.
    const workspaceModel = fakeModel();
    fake.show(workspaceModel);
    expect(playbackModel.marks()).toEqual([]);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    expect(workspaceModel.marks()).toEqual([[CARET, "3:5-3:5"]]);

    // Back on the first model, with the caret where it was last drawn there.
    fake.show(playbackModel);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    expect(playbackModel.marks()).toEqual([[CARET, "3:5-3:5"]]);
    expect(workspaceModel.marks()).toEqual([]);
  });

  // The marks were once model decorations with no owner. An editor disposed while a
  // lesson played (the recording opened an image) left them on the playback model, and
  // the editor mounted on that model afterwards drew a second, frozen caret.
  it("leaves no mark behind for the next editor on the same model", () => {
    const model = fakeModel();
    const first = fakeEditor(model);
    first.blur();
    showRecordedCaret(first.editor, caretAt(3, 5));
    expect(model.marks()).toEqual([[CARET, "3:5-3:5"]]);

    first.dispose();
    const second = fakeEditor(model);
    second.blur();
    showRecordedCaret(second.editor, caretAt(8, 2));

    expect(model.marks()).toEqual([[CARET, "8:2-8:2"]]);
  });

  it("is cleared with the lesson", () => {
    const fake = fakeEditor();
    fake.blur();
    showRecordedCaret(fake.editor, caretAt(3, 5));

    clearCursorDecorations(actionArgsFor(fake.editor));

    expect(fake.model().marks()).toEqual([]);
    // Nothing to clear without an editor, or for one that showed no caret.
    clearCursorDecorations(actionArgsFor(null));
    clearRecordedCaret(fakeEditor().editor);
  });
});

describe("a caret the learner places while the lesson plays", () => {
  it("stays where they put it, with the recorded caret drawn dimmed beside it", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    fake.setSelection.mockClear();

    // The learner clicks further down. The recorded caret is marked at once, without
    // waiting for the recording's next frame.
    fake.moveCaret("mouse", caretAt(20, 7));
    expect(isLearnerCaretHeld(fake.editor)).toBe(true);
    expect(fake.model().marks()).toEqual([[DIMMED_CARET, "3:5-3:5"]]);

    // The recording goes on: it selects a word, and the learner's caret does not move.
    showRecordedCaret(fake.editor, selectionTo(3, 5, 3, 11));
    expect(fake.setSelection).not.toHaveBeenCalled();
    expect(fake.selection()).toEqual(caretAt(20, 7));
    expect(fake.model().marks()).toEqual([
      [SELECTION, "3:5-3:11"],
      [DIMMED_CARET, "3:11-3:11"],
    ]);

    tracking.dispose();
  });

  // Arrow keys, Go to Line, Find's next match and a right-click all place the caret.
  it.each(["keyboard", "code.jump", "api"])("is theirs after a %s cursor change too", (source) => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));

    fake.moveCaret(source, caretAt(4, 5));

    expect(isLearnerCaretHeld(fake.editor)).toBe(true);
    tracking.dispose();
  });

  // A click on the very spot the recorded caret is on changes no cursor, so Monaco
  // reports nothing: the press itself is the gesture.
  it.each([
    ["the text", CONTENT_TEXT],
    ["the space after a line", CONTENT_EMPTY],
  ])("is theirs after a press on %s that moves no cursor", (_name, target) => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));

    fake.pressOn(target);

    expect(isLearnerCaretHeld(fake.editor)).toBe(true);
    expect(fake.model().marks()).toEqual([[DIMMED_CARET, "3:5-3:5"]]);
    tracking.dispose();
  });

  // On a phone a tap never reaches onMouseDown, and one on the recorded caret's own
  // spot moves no cursor either.
  it("is theirs after a tap on the text", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));

    fake.tap();
    expect(isLearnerCaretHeld(fake.editor)).toBe(true);

    // Nothing listens once the tracking is disposed.
    tracking.dispose();
    fake.tap();
    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
  });

  // Escape, then Tab, is how a keyboard user leaves the editor. Over a recorded
  // selection Monaco answers Escape by collapsing the selection, a "keyboard" cursor
  // change like an arrow key's, and the learner has placed nothing.
  it("is not taken by Escape collapsing the recorded selection", async () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, selectionTo(3, 5, 3, 11));

    fake.pressKey("Escape", () => fake.moveCaret("keyboard", caretAt(3, 11)));
    expect(isLearnerCaretHeld(fake.editor)).toBe(false);

    // The recording's next frame puts its selection back.
    showRecordedCaret(fake.editor, selectionTo(3, 5, 3, 12));
    expect(fake.selection()).toEqual(selectionTo(3, 5, 3, 12));

    // Only that keydown is exempt: an arrow key afterwards places the caret.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.pressKey("ArrowDown", () => fake.moveCaret("keyboard", caretAt(4, 12)));
    expect(isLearnerCaretHeld(fake.editor)).toBe(true);
    tracking.dispose();
  });

  it.each([
    ["the scrollbar", SCROLLBAR],
    ["a line number", GUTTER_LINE_NUMBERS],
  ])("is not taken by a press on %s that moves no cursor", (_name, target) => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));

    fake.pressOn(target);

    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    tracking.dispose();
  });

  // Replay sets the selection, restores view states and edits the text; Monaco reports
  // a cursor change for each before the write returns.
  it("is not taken by the cursor changes replay's own writes cause", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);

    // The selection write inside showRecordedCaret reports "api".
    showRecordedCaret(fake.editor, caretAt(3, 5));
    // So would any other write a frame makes.
    asReplayWrite(() => fake.moveCaret("api", caretAt(3, 6)));
    asReplayWrite(() => fake.moveCaret("keyboard", caretAt(3, 7)));

    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    showRecordedCaret(fake.editor, caretAt(3, 8));
    expect(fake.selection()).toEqual(caretAt(3, 8));
    tracking.dispose();
  });

  // Monaco moving the caret along with the text or the layout, and CodeEditor restoring
  // a file's view, are nobody's gesture, whenever they happen.
  it.each(["modelChange", "model", "viewModel", "restoreState"])(
    "is not taken by a %s cursor change",
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
    fake.pressOn(CONTENT_TEXT);

    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    expect(fake.draws).not.toHaveBeenCalled();
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

  // Stop rewinds the lesson in the same machine step that leaves `playing`, before
  // React disposes the tracking: the opening frame's caret must be the editor's.
  it("goes back to the recording the moment the lesson stops playing", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    fake.moveCaret("mouse", caretAt(20, 7));
    fake.setSelection.mockClear();

    // Leaving `playing` writes nothing: the editor may be about to show the file handed
    // over, with the caret the learner placed.
    releaseLearnerCaretHold(actionArgsFor(fake.editor));
    releaseLearnerCaretHold(actionArgsFor(null));
    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    expect(fake.setSelection).not.toHaveBeenCalled();
    expect(fake.selection()).toEqual(caretAt(20, 7));

    // The rewind's frame moves the editor's caret, and its mark is gone.
    showRecordedCaret(fake.editor, caretAt(1, 1));
    expect(fake.selection()).toEqual(caretAt(1, 1));
    expect(fake.model().marks()).toEqual([]);
    tracking.dispose();
  });

  it("goes back to the recording when the tracking ends", () => {
    const fake = fakeEditor();
    const tracking = trackLearnerCaret(fake.editor, () => true);
    showRecordedCaret(fake.editor, caretAt(3, 5));
    fake.moveCaret("mouse", caretAt(20, 7));
    fake.setSelection.mockClear();

    tracking.dispose();
    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
    expect(fake.setSelection).not.toHaveBeenCalled();

    // Nothing listens any more.
    fake.moveCaret("mouse", caretAt(21, 1));
    expect(isLearnerCaretHeld(fake.editor)).toBe(false);
  });
});

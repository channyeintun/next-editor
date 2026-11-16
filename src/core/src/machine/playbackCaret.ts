import type * as monaco from "monaco-editor";
import type { EditorSelection } from "../types";
import { applySelectionDiff } from "../utils/editorDiff";
import type { EditorActionArgs } from "./types";

// ============================================================================
// The caret in the editor while a lesson plays.
//
// The editor has one caret of its own, and replay moves it as the recording did.
// A learner who clicks or arrows into the code takes that caret: from then on
// replay leaves it where they put it, so what they type next (which pauses the
// lesson, see playbackInteraction.ts) lands there and not where the recording
// had last put it. The recorded caret and selection are drawn as decorations
// meanwhile, dimmed, so the bright caret is plainly the learner's. The caret
// mark also stands in whenever the editor has no focus and Monaco hides its own.
//
// The caret is the learner's only while the lesson plays and only in the model
// they placed it in. frameReplay.ts wraps its writes in asReplayWrite and reports
// each recorded selection (showRecordedCaret); playbackInteraction.ts watches for
// the learner's gestures while the lesson plays (trackLearnerCaret); the machine
// takes the caret back when `playing` is left (releaseLearnerCaretHold).
// Everything is kept per editor.
// ============================================================================

type Editor = monaco.editor.IStandaloneCodeEditor;
type Mark = monaco.editor.IModelDeltaDecoration;

/** Color of the playback caret's marks in the minimap and the overview ruler. */
const PLAYBACK_CURSOR_COLOR = "#007ACC";

const CARET_CLASS = "playback-cursor-decoration";
/** Added to the caret mark while the learner holds the editor's caret: dimmed and steady. */
const CARET_BESIDE_LEARNER_CLASS = `${CARET_CLASS} playback-cursor-decoration--beside-learner`;
const SELECTION_CLASS = "playback-selection-decoration";

/**
 * Cursor changes that are nobody's gesture: Monaco moving the caret along with a
 * change of content ("modelChange", "model") or of layout ("viewModel"), and a view
 * state being restored ("restoreState", CodeEditor's own as it shows a file). Any other
 * change outside a replay write is the learner's: a click or a drag ("mouse"), a key
 * ("keyboard"), Go to Line ("code.jump"), Find or a right-click ("api").
 */
const UNATTENDED_CURSOR_SOURCES: ReadonlySet<string> = new Set([
  "modelChange",
  "model",
  "viewModel",
  "restoreState",
]);

// monaco.editor.MouseTargetType, as numbers so that this core module never
// value-imports monaco-editor (see the marks below).
const MOUSE_TARGET_CONTENT_TEXT = 6;
const MOUSE_TARGET_CONTENT_EMPTY = 7;

interface PlaybackCaret {
  /** The recorded selection replay last showed, to mark the moment the learner takes the caret. */
  recorded: EditorSelection | null;
  /**
   * The model in which the learner placed the editor's own caret, which replay then
   * leaves to them, or null while the caret is the recording's. The caret is theirs
   * only in that model: Monaco starts another one with a caret of its own.
   */
  learnerModel: monaco.editor.ITextModel | null;
  /**
   * The marks last drawn, in a collection the editor owns: Monaco takes an editor's
   * decorations off a model as the editor leaves it or is disposed, so no mark is left
   * behind for the next editor on that model.
   */
  marks: Mark[];
  decorations: monaco.editor.IEditorDecorationsCollection | null;
}

const carets = new WeakMap<Editor, PlaybackCaret>();

function caretOf(editor: Editor): PlaybackCaret {
  let caret = carets.get(editor);
  if (!caret) {
    caret = { recorded: null, learnerModel: null, marks: [], decorations: null };
    carets.set(editor, caret);
  }
  return caret;
}

/** Whether the editor's caret, in the model it shows, is one the learner placed. */
const learnerHoldsCaret = (editor: Editor, caret: PlaybackCaret): boolean =>
  caret.learnerModel !== null && caret.learnerModel === editor.getModel();

/**
 * True while replay itself writes to the editor. Monaco reports the cursor changes
 * such a write causes before the write returns, so a change reported meanwhile is
 * replay's own and never the learner's.
 */
let isReplayWriting = false;

/** Runs replay's write to the editor, so the cursor changes it causes are not taken for the learner's. */
export function asReplayWrite(write: () => void): void {
  const wasWriting = isReplayWriting;
  isReplayWriting = true;
  try {
    write();
  } finally {
    isReplayWriting = wasWriting;
  }
}

// The marks are plain IRanges (not `new Range(...)`) so this core module never
// value-imports monaco-editor; Monaco's decoration API lifts an IRange itself.
// That keeps the 3.7 MB editor chunk out of the eager route graph (it loads
// lazily with CodeEditor instead).

const caretMark = (
  selection: Pick<EditorSelection, "positionLineNumber" | "positionColumn">,
  className: string = CARET_CLASS,
): Mark => ({
  range: {
    startLineNumber: selection.positionLineNumber,
    startColumn: selection.positionColumn,
    endLineNumber: selection.positionLineNumber,
    endColumn: selection.positionColumn,
  },
  options: {
    className,
    stickiness: 1, // NeverGrowsWhenTypingAtEdges
    minimap: {
      color: PLAYBACK_CURSOR_COLOR,
      position: 1, // Inline
    },
    overviewRuler: {
      color: PLAYBACK_CURSOR_COLOR,
      position: 2, // Center
    },
  },
});

const selectionMark = (selection: EditorSelection): Mark => ({
  range: {
    startLineNumber: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLineNumber: selection.endLineNumber,
    endColumn: selection.endColumn,
  },
  options: {
    className: SELECTION_CLASS,
    stickiness: 1, // NeverGrowsWhenTypingAtEdges
  },
});

const isEmptySelection = (selection: EditorSelection): boolean =>
  selection.startLineNumber === selection.endLineNumber &&
  selection.startColumn === selection.endColumn;

const areMarksEqual = (current: readonly Mark[], next: readonly Mark[]): boolean =>
  current.length === next.length &&
  current.every((mark, index) => {
    const other = next[index];
    return (
      mark.options.className === other.options.className &&
      mark.range.startLineNumber === other.range.startLineNumber &&
      mark.range.startColumn === other.range.startColumn &&
      mark.range.endLineNumber === other.range.endLineNumber &&
      mark.range.endColumn === other.range.endColumn
    );
  });

/** Replaces the drawn marks, touching the editor only when they differ. */
function setMarks(editor: Editor, caret: PlaybackCaret, marks: Mark[]): void {
  // The marks last drawn are gone if the editor has since shown another model, or the
  // model's text was replaced: the collection then has no range for them.
  const stillDrawn = caret.marks.length > 0 && caret.decorations?.getRange(0) != null;
  const drawn = stillDrawn ? caret.marks : [];
  caret.marks = marks;
  if (areMarksEqual(drawn, marks)) return;

  if (caret.decorations) {
    caret.decorations.set(marks);
  } else {
    caret.decorations = editor.createDecorationsCollection(marks);
  }
}

function drawRecordedCaret(editor: Editor, caret: PlaybackCaret): void {
  const { recorded } = caret;
  if (!recorded) return;

  if (learnerHoldsCaret(editor, caret)) {
    // The editor's caret is the learner's: the recording's is drawn beside it.
    const recordedCaret = caretMark(recorded, CARET_BESIDE_LEARNER_CLASS);
    setMarks(
      editor,
      caret,
      isEmptySelection(recorded) ? [recordedCaret] : [selectionMark(recorded), recordedCaret],
    );
  } else if (editor.hasTextFocus()) {
    // Monaco shows its own caret, which replay has put on the recorded one. A mark
    // as well would draw the caret twice.
    setMarks(editor, caret, []);
  } else {
    // Monaco hides its caret without focus. Every cursor is marked, so a recorded
    // multi-cursor (restored with the view state) shows all of its carets.
    setMarks(
      editor,
      caret,
      (editor.getSelections() ?? [recorded]).map((selection) => caretMark(selection)),
    );
  }
}

/**
 * Shows the recorded caret and selection in the editor: as the editor's own, unless the
 * learner holds that one, in which case as decorations beside theirs.
 */
export function showRecordedCaret(editor: Editor, selection: EditorSelection): void {
  const caret = caretOf(editor);
  caret.recorded = selection;
  if (!learnerHoldsCaret(editor, caret)) {
    asReplayWrite(() => applySelectionDiff(editor, selection));
  }
  drawRecordedCaret(editor, caret);
}

/** Whether the learner has placed the editor's caret, so replay must leave it alone. */
export function isLearnerCaretHeld(editor: Editor): boolean {
  const caret = carets.get(editor);
  return caret !== undefined && learnerHoldsCaret(editor, caret);
}

/**
 * Gives the editor's caret back to the recording. Writes nothing to the editor, which
 * may already show the file handed over to the learner, with the caret they placed:
 * replay's next write moves it.
 */
export function releaseLearnerCaret(editor: Editor): void {
  const caret = carets.get(editor);
  if (caret) caret.learnerModel = null;
}

/**
 * While a lesson plays, hands the editor's caret to the learner the moment they place
 * it: any cursor change that is neither replay's write nor Monaco following the text,
 * and a press on the text itself (a click on the very spot the recorded caret is on
 * changes no cursor). `isPlaying` is asked each time, since the key that pauses the
 * lesson moves the caret too, before this tracking is disposed.
 *
 * The caret goes back to the recording when the editor shows another model (the
 * recording opened another file: the learner's caret stayed in the one it left) and
 * when the tracking is disposed.
 */
export function trackLearnerCaret(editor: Editor, isPlaying: () => boolean): monaco.IDisposable {
  const take = () => {
    if (isReplayWriting || !isPlaying()) return;
    const caret = caretOf(editor);
    if (learnerHoldsCaret(editor, caret)) return;
    caret.learnerModel = editor.getModel();
    // The editor's caret was the recording's until now: mark where that is.
    drawRecordedCaret(editor, caret);
  };
  const listeners = [
    editor.onDidChangeCursorSelection((event) => {
      if (!UNATTENDED_CURSOR_SOURCES.has(event.source)) take();
    }),
    editor.onMouseDown((event) => {
      const target = event.target.type;
      if (target === MOUSE_TARGET_CONTENT_TEXT || target === MOUSE_TARGET_CONTENT_EMPTY) take();
    }),
    editor.onDidChangeModel(() => releaseLearnerCaret(editor)),
  ];

  return {
    dispose() {
      for (const listener of listeners) listener.dispose();
      releaseLearnerCaret(editor);
    },
  };
}

/** Removes the recorded caret's marks and forgets the editor (the lesson was unloaded). */
export function clearRecordedCaret(editor: Editor): void {
  const caret = carets.get(editor);
  if (!caret) return;
  caret.decorations?.clear();
  carets.delete(editor);
}

// ----------------------------------------------------------------------------
// Machine actions, registered in editorMachine.ts.
// ----------------------------------------------------------------------------

/**
 * Leaving `playing` (pause, end, stop, restoring saved edits): whatever replay applies
 * next, a rewind or a seek, moves the editor's caret again. It runs before the
 * transition's own actions, and before React disposes the tracking.
 */
export const releaseLearnerCaretHold = ({ context }: EditorActionArgs): void => {
  const { editor } = context.editorRefs;
  if (editor) releaseLearnerCaret(editor);
};

/** Leaving playback: the recorded caret's marks go with the lesson. */
export const clearCursorDecorations = ({ context }: EditorActionArgs): void => {
  const { editor } = context.editorRefs;
  if (editor) clearRecordedCaret(editor);
};

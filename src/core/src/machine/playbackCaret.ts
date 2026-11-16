import type * as monaco from "monaco-editor";
import type { EditorSelection } from "../types";
import { applySelectionDiff } from "../utils/editorDiff";

// ============================================================================
// The caret in the editor while a lesson plays.
//
// The editor has one caret of its own, and replay moves it as the recording did.
// A learner who clicks or arrows into the code takes that caret: from then on
// replay leaves it where they put it, so what they type next (which pauses the
// lesson, see playbackInteraction.ts) lands there and not where the recording
// had last put it. The recorded caret and selection are drawn as decorations
// meanwhile. The same caret mark stands in whenever the editor has no focus and
// Monaco hides its own caret.
//
// frameReplay.ts reports each recorded selection (showRecordedCaret);
// playbackInteraction.ts watches for the learner's moves while the lesson plays
// (trackLearnerCaret). Everything is kept per editor, so a remounted editor
// starts clean.
// ============================================================================

type Editor = monaco.editor.IStandaloneCodeEditor;
type Mark = monaco.editor.IModelDeltaDecoration;

/** Color of the playback caret's marks in the minimap and the overview ruler. */
const PLAYBACK_CURSOR_COLOR = "#007ACC";

/**
 * Cursor changes the learner makes: a click, a drag or a tap, and keyboard navigation.
 * Replay's own writes report "api" (setSelection), "restoreState" (restoreViewState),
 * "modelChange" (a replayed edit moving the caret along) or "model" (setValue).
 */
const LEARNER_CURSOR_SOURCES: ReadonlySet<string> = new Set(["mouse", "keyboard"]);

interface PlaybackCaret {
  /** The recorded selection replay last showed, to mark the moment the learner takes the caret. */
  recorded: EditorSelection | null;
  /**
   * The model in which the learner placed the editor's own caret, which replay then
   * leaves to them, or null while the caret is the recording's. The caret is theirs
   * only in that model: Monaco starts another one with a caret of its own.
   */
  learnerModel: monaco.editor.ITextModel | null;
  /** The marks drawn, with their ids in the model they were drawn on. */
  marks: Mark[];
  markIds: string[];
  markedModel: monaco.editor.ITextModel | null;
}

const carets = new WeakMap<Editor, PlaybackCaret>();

function caretOf(editor: Editor): PlaybackCaret {
  let caret = carets.get(editor);
  if (!caret) {
    caret = { recorded: null, learnerModel: null, marks: [], markIds: [], markedModel: null };
    carets.set(editor, caret);
  }
  return caret;
}

/** Whether the editor's caret, in the model it shows, is one the learner placed. */
const learnerHoldsCaret = (editor: Editor, caret: PlaybackCaret): boolean =>
  caret.learnerModel !== null && caret.learnerModel === editor.getModel();

// The marks are plain IRanges (not `new Range(...)`) so this core module never
// value-imports monaco-editor; Monaco's decoration API lifts an IRange itself.
// That keeps the 3.7 MB editor chunk out of the eager route graph (it loads
// lazily with CodeEditor instead).

const caretMark = (
  selection: Pick<EditorSelection, "positionLineNumber" | "positionColumn">,
): Mark => ({
  range: {
    startLineNumber: selection.positionLineNumber,
    startColumn: selection.positionColumn,
    endLineNumber: selection.positionLineNumber,
    endColumn: selection.positionColumn,
  },
  options: {
    className: "playback-cursor-decoration",
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
    className: "playback-selection-decoration",
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

/** Replaces the drawn marks, touching the model only when they differ. */
function setMarks(editor: Editor, caret: PlaybackCaret, marks: Mark[]): void {
  const model = editor.getModel();

  if (caret.markedModel !== model) {
    // The editor shows another model (the lesson handed the file over, or took it
    // back): the marks stayed on the one it left.
    if (caret.markedModel && caret.markIds.length > 0 && !caret.markedModel.isDisposed()) {
      caret.markedModel.deltaDecorations(caret.markIds, []);
    }
    caret.markedModel = model;
    caret.markIds = [];
    caret.marks = [];
  }

  if (!model || areMarksEqual(caret.marks, marks)) return;
  caret.markIds = model.deltaDecorations(caret.markIds, marks);
  caret.marks = marks;
}

function drawRecordedCaret(editor: Editor, caret: PlaybackCaret): void {
  const { recorded } = caret;
  if (!recorded) return;

  if (learnerHoldsCaret(editor, caret)) {
    // The editor's caret is the learner's: the recording's is drawn.
    setMarks(
      editor,
      caret,
      isEmptySelection(recorded)
        ? [caretMark(recorded)]
        : [selectionMark(recorded), caretMark(recorded)],
    );
  } else if (editor.hasTextFocus()) {
    // Monaco shows its own caret, which replay has put on the recorded one. A mark
    // as well would draw the caret twice.
    setMarks(editor, caret, []);
  } else {
    // Monaco hides its caret without focus. Every cursor is marked, so a recorded
    // multi-cursor (restored with the view state) shows all of its carets.
    setMarks(editor, caret, (editor.getSelections() ?? [recorded]).map(caretMark));
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
    applySelectionDiff(editor, selection);
  }
  drawRecordedCaret(editor, caret);
}

/** Whether the learner has placed the editor's caret, so replay must leave it alone. */
export function isLearnerCaretHeld(editor: Editor): boolean {
  const caret = carets.get(editor);
  return caret !== undefined && learnerHoldsCaret(editor, caret);
}

/**
 * While a lesson plays, hands the editor's caret to the learner the moment they move it.
 * `isPlaying` is asked on each move, since a key that pauses the lesson also moves the
 * caret before this tracking is disposed.
 *
 * The caret goes back to the recording when the editor shows another model (the
 * recording opened another file: the learner's caret stayed in the one it left) and
 * when the tracking is disposed, for the next stretch of playback. Neither writes
 * anything to the editor, which by then may show the file handed over to the learner,
 * with the caret they placed.
 */
export function trackLearnerCaret(editor: Editor, isPlaying: () => boolean): monaco.IDisposable {
  const release = () => {
    const caret = carets.get(editor);
    if (caret) caret.learnerModel = null;
  };
  const cursorListener = editor.onDidChangeCursorSelection((event) => {
    if (!LEARNER_CURSOR_SOURCES.has(event.source) || !isPlaying()) return;
    const caret = caretOf(editor);
    if (learnerHoldsCaret(editor, caret)) return;
    caret.learnerModel = editor.getModel();
    // The editor's caret was the recording's until this move: mark where that is now.
    drawRecordedCaret(editor, caret);
  });
  const modelListener = editor.onDidChangeModel(release);

  return {
    dispose() {
      cursorListener.dispose();
      modelListener.dispose();
      release();
    },
  };
}

/** Removes the recorded caret's marks and forgets the editor (the lesson was unloaded). */
export function clearRecordedCaret(editor: Editor): void {
  const caret = carets.get(editor);
  if (!caret) return;
  setMarks(editor, caret, []);
  carets.delete(editor);
}

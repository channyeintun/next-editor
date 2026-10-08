import type * as monaco from "monaco-editor";
import type { EditorFrame, EditorPosition, EditorSelection, Recording } from "../types";
import type { DeltaFrame } from "./deltaTypes";
import { isKeyframe } from "./deltaTypes";

function toFiniteInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.trunc(value);
}

function selectionToPosition(
  selection: Partial<EditorSelection> | null | undefined,
): Partial<EditorPosition> | null {
  if (!selection) {
    return null;
  }

  return {
    lineNumber:
      typeof selection.positionLineNumber === "number"
        ? selection.positionLineNumber
        : typeof selection.endLineNumber === "number"
          ? selection.endLineNumber
          : selection.startLineNumber,
    column:
      typeof selection.positionColumn === "number"
        ? selection.positionColumn
        : typeof selection.endColumn === "number"
          ? selection.endColumn
          : selection.startColumn,
  };
}

/** Monaco's first cursor in a saved view state, or null when there is none. */
function getPrimaryCursorState(
  viewState: monaco.editor.ICodeEditorViewState | null | undefined,
): Record<string, unknown> | null {
  const cursorState = (viewState as { cursorState?: unknown } | null | undefined)?.cursorState;
  const primaryCursorState: unknown = Array.isArray(cursorState) ? cursorState[0] : null;
  return primaryCursorState && typeof primaryCursorState === "object"
    ? (primaryCursorState as Record<string, unknown>)
    : null;
}

function getPrimaryCursorSelection(
  viewState: monaco.editor.ICodeEditorViewState | null | undefined,
): Partial<EditorSelection> | null {
  return (getPrimaryCursorState(viewState)?.selection as Partial<EditorSelection> | null) ?? null;
}

function getPrimaryCursorPosition(
  viewState: monaco.editor.ICodeEditorViewState | null | undefined,
): Partial<EditorPosition> | null {
  return (getPrimaryCursorState(viewState)?.position as Partial<EditorPosition> | null) ?? null;
}

/** Monaco lines and columns are 1-based. */
const MIN_LINE_OR_COLUMN = 1;

/**
 * A line or column: `value` when it is finite, else `fallback` when that is, else
 * `last`, truncated and floored at 1. It stays fixed-arity because it runs for every
 * field of every selection a replayed delta fold normalizes.
 */
function toLineOrColumn(value: unknown, fallback: unknown, last: number): number {
  return Math.max(MIN_LINE_OR_COLUMN, toFiniteInteger(value, toFiniteInteger(fallback, last)));
}

export function normalizeEditorPosition(
  position: Partial<EditorPosition> | null | undefined,
  fallback?: Partial<EditorPosition> | null,
): EditorPosition {
  return {
    lineNumber: toLineOrColumn(position?.lineNumber, fallback?.lineNumber, 1),
    column: toLineOrColumn(position?.column, fallback?.column, 1),
  };
}

/**
 * A complete selection from a partial one. Each field takes the selection's own finite
 * value, else `fallback`'s, else one derived from a field resolved before it:
 *
 * - start: `fallbackPosition`, else the fallback selection's caret, else 1:1;
 * - end: start, so a missing selection collapses to a caret;
 * - selectionStart (the anchor): start;
 * - position (the caret): end, as in Monaco's default left-to-right selection.
 *
 * Values are truncated and floored at line and column 1.
 */
export function normalizeEditorSelection(
  selection: Partial<EditorSelection> | null | undefined,
  fallback?: Partial<EditorSelection> | null,
  fallbackPosition?: Partial<EditorPosition> | null,
): EditorSelection {
  const normalizedFallbackPosition = normalizeEditorPosition(
    fallbackPosition ?? selectionToPosition(fallback),
  );
  const startLineNumber = toLineOrColumn(
    selection?.startLineNumber,
    fallback?.startLineNumber,
    normalizedFallbackPosition.lineNumber,
  );
  const startColumn = toLineOrColumn(
    selection?.startColumn,
    fallback?.startColumn,
    normalizedFallbackPosition.column,
  );
  const endLineNumber = toLineOrColumn(
    selection?.endLineNumber,
    fallback?.endLineNumber,
    startLineNumber,
  );
  const endColumn = toLineOrColumn(selection?.endColumn, fallback?.endColumn, startColumn);

  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    selectionStartLineNumber: toLineOrColumn(
      selection?.selectionStartLineNumber,
      fallback?.selectionStartLineNumber,
      startLineNumber,
    ),
    selectionStartColumn: toLineOrColumn(
      selection?.selectionStartColumn,
      fallback?.selectionStartColumn,
      startColumn,
    ),
    positionLineNumber: toLineOrColumn(
      selection?.positionLineNumber,
      fallback?.positionLineNumber,
      endLineNumber,
    ),
    positionColumn: toLineOrColumn(selection?.positionColumn, fallback?.positionColumn, endColumn),
  };
}

export function normalizeEditorViewState(
  viewState: monaco.editor.ICodeEditorViewState | null | undefined,
  selection?: Partial<EditorSelection> | null,
  position?: Partial<EditorPosition> | null,
): monaco.editor.ICodeEditorViewState | null {
  if (!viewState) {
    return null;
  }

  const normalizedSelection = normalizeEditorSelection(selection, undefined, position);
  const normalizedPosition = normalizeEditorPosition(
    position ?? selectionToPosition(normalizedSelection),
    selectionToPosition(normalizedSelection),
  );
  const clonedViewState = structuredClone(viewState) as unknown as Record<string, unknown>;

  if (Array.isArray(clonedViewState.cursorState)) {
    clonedViewState.cursorState = clonedViewState.cursorState.map((cursorState) => {
      if (!cursorState || typeof cursorState !== "object") {
        return cursorState;
      }

      const normalizedCursorState = {
        ...(cursorState as Record<string, unknown>),
      };
      const cursorSelection = normalizeEditorSelection(
        normalizedCursorState.selection as Partial<EditorSelection> | null,
        normalizedSelection,
        normalizedPosition,
      );

      normalizedCursorState.selection = cursorSelection;
      normalizedCursorState.position = normalizeEditorPosition(
        normalizedCursorState.position as Partial<EditorPosition> | null,
        selectionToPosition(cursorSelection),
      );

      return normalizedCursorState;
    });
  }

  return clonedViewState as unknown as monaco.editor.ICodeEditorViewState;
}

/**
 * `viewState` with its primary cursor (the one normalizeEditorFrame reads back as the
 * frame's selection and position) set to `selection` and `position`; the other cursors
 * are kept. It returns a shallow copy, so it never writes into its input, and a view
 * state with no primary cursor comes back as it is.
 */
export function withPrimaryCursorSelection(
  viewState: monaco.editor.ICodeEditorViewState | null,
  selection: EditorSelection,
  position: EditorPosition,
): monaco.editor.ICodeEditorViewState | null {
  const primaryCursorState = getPrimaryCursorState(viewState);
  if (!viewState || !primaryCursorState) {
    return viewState;
  }

  const [, ...otherCursorStates] = viewState.cursorState;
  const cursorState = {
    ...primaryCursorState,
    inSelectionMode:
      selection.selectionStartLineNumber !== selection.positionLineNumber ||
      selection.selectionStartColumn !== selection.positionColumn,
    selectionStart: {
      lineNumber: selection.selectionStartLineNumber,
      column: selection.selectionStartColumn,
    },
    position,
    selection,
  };
  return { ...viewState, cursorState: [cursorState, ...otherCursorStates] };
}

export function normalizeEditorFrame(frame: EditorFrame): EditorFrame {
  const initialPosition = normalizeEditorPosition(frame.state.position);
  const initialSelection = normalizeEditorSelection(
    frame.state.selection,
    undefined,
    initialPosition,
  );
  // One pass fills every cursor's selection and position, so the primary cursor
  // read back below already agrees with this view state: it needs no second pass.
  const viewState = normalizeEditorViewState(
    frame.state.viewState,
    initialSelection,
    initialPosition,
  );
  const position = normalizeEditorPosition(
    getPrimaryCursorPosition(viewState) ?? frame.state.position,
    initialPosition,
  );
  const selection = normalizeEditorSelection(
    getPrimaryCursorSelection(viewState) ?? frame.state.selection,
    initialSelection,
    position,
  );

  return {
    ...frame,
    state: {
      ...frame.state,
      content:
        typeof frame.state.content === "string"
          ? frame.state.content
          : String(frame.state.content ?? ""),
      position,
      selection,
      viewState,
    },
  };
}

export function normalizeDeltaFrame(frame: DeltaFrame): DeltaFrame {
  if (isKeyframe(frame)) {
    return {
      ...normalizeEditorFrame(frame),
      isKeyframe: true,
    };
  }

  return {
    ...frame,
    isKeyframe: false,
    viewState:
      frame.viewState === undefined ? undefined : normalizeEditorViewState(frame.viewState),
  };
}

/**
 * Frame arrays that hold only normalized frames: ones the codec decoded (it normalizes
 * each frame as it arrives), a take's captured frames (keyframes and view states are
 * normalized as they are taken), and normalizeRecordingData's own results. Normalizing
 * one again deep-cloned every view state and changed nothing. Such an array may only
 * ever grow by frames of the same kind: decoded stream deltas, or captures.
 */
const normalizedFrameArrays = new WeakSet<readonly DeltaFrame[]>();

/** Records that every frame in `frames` is already normalized (see normalizedFrameArrays). */
export function markFramesNormalized(frames: readonly DeltaFrame[]): void {
  normalizedFrameArrays.add(frames);
}

export function normalizeRecordingData(recording: Recording): Recording {
  // Either way the caller gets its own array, as callers that append in place expect.
  const frames = normalizedFrameArrays.has(recording.frames)
    ? recording.frames.slice()
    : recording.frames.map((frame) => normalizeDeltaFrame(frame));
  normalizedFrameArrays.add(frames);
  return { ...recording, frames };
}

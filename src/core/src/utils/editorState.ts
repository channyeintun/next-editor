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

export function normalizeEditorPosition(
  position: Partial<EditorPosition> | null | undefined,
  fallback?: Partial<EditorPosition> | null,
): EditorPosition {
  const fallbackLineNumber = Math.max(1, toFiniteInteger(fallback?.lineNumber, 1));
  const fallbackColumn = Math.max(1, toFiniteInteger(fallback?.column, 1));

  return {
    lineNumber: Math.max(1, toFiniteInteger(position?.lineNumber, fallbackLineNumber)),
    column: Math.max(1, toFiniteInteger(position?.column, fallbackColumn)),
  };
}

export function normalizeEditorSelection(
  selection: Partial<EditorSelection> | null | undefined,
  fallback?: Partial<EditorSelection> | null,
  fallbackPosition?: Partial<EditorPosition> | null,
): EditorSelection {
  const normalizedFallbackPosition = normalizeEditorPosition(
    fallbackPosition ?? selectionToPosition(fallback),
  );
  const startLineNumber = Math.max(
    1,
    toFiniteInteger(
      selection?.startLineNumber,
      toFiniteInteger(fallback?.startLineNumber, normalizedFallbackPosition.lineNumber),
    ),
  );
  const startColumn = Math.max(
    1,
    toFiniteInteger(
      selection?.startColumn,
      toFiniteInteger(fallback?.startColumn, normalizedFallbackPosition.column),
    ),
  );
  const endLineNumber = Math.max(
    1,
    toFiniteInteger(
      selection?.endLineNumber,
      toFiniteInteger(fallback?.endLineNumber, startLineNumber),
    ),
  );
  const endColumn = Math.max(
    1,
    toFiniteInteger(selection?.endColumn, toFiniteInteger(fallback?.endColumn, startColumn)),
  );

  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    selectionStartLineNumber: Math.max(
      1,
      toFiniteInteger(
        selection?.selectionStartLineNumber,
        toFiniteInteger(fallback?.selectionStartLineNumber, startLineNumber),
      ),
    ),
    selectionStartColumn: Math.max(
      1,
      toFiniteInteger(
        selection?.selectionStartColumn,
        toFiniteInteger(fallback?.selectionStartColumn, startColumn),
      ),
    ),
    positionLineNumber: Math.max(
      1,
      toFiniteInteger(
        selection?.positionLineNumber,
        toFiniteInteger(fallback?.positionLineNumber, endLineNumber),
      ),
    ),
    positionColumn: Math.max(
      1,
      toFiniteInteger(
        selection?.positionColumn,
        toFiniteInteger(fallback?.positionColumn, endColumn),
      ),
    ),
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

export function normalizeRecordingData(recording: Recording): Recording {
  return {
    ...recording,
    frames: recording.frames.map((frame) => normalizeDeltaFrame(frame)),
  };
}

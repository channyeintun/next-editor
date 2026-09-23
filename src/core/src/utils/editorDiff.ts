import type * as monaco from "monaco-editor";
import { findCommonPrefixJS, findCommonSuffixJS } from "./stringAffix";
import type { EditorPosition, EditorSelection } from "../types";

/**
 * Checks if two positions are equal
 */
export function arePositionsEqual(
  pos1: EditorPosition | null,
  pos2: EditorPosition | null,
): boolean {
  if (!pos1 || !pos2) return pos1 === pos2;
  return pos1.lineNumber === pos2.lineNumber && pos1.column === pos2.column;
}

/**
 * Checks if two selections are equal
 */
export function areSelectionsEqual(
  sel1: EditorSelection | null,
  sel2: EditorSelection | null,
): boolean {
  if (!sel1 || !sel2) return sel1 === sel2;
  return (
    sel1.startLineNumber === sel2.startLineNumber &&
    sel1.startColumn === sel2.startColumn &&
    sel1.endLineNumber === sel2.endLineNumber &&
    sel1.endColumn === sel2.endColumn &&
    sel1.selectionStartLineNumber === sel2.selectionStartLineNumber &&
    sel1.selectionStartColumn === sel2.selectionStartColumn &&
    sel1.positionLineNumber === sel2.positionLineNumber &&
    sel1.positionColumn === sel2.positionColumn
  );
}

/**
 * Applies cursor position only if it has changed
 */
export const applyPositionDiff = (
  editor: monaco.editor.IStandaloneCodeEditor,
  targetPosition: EditorPosition,
  knownCurrentPosition?: EditorPosition | null,
): boolean => {
  const actualCurrentPosition = editor.getPosition();
  const currentPosition =
    knownCurrentPosition !== undefined &&
    arePositionsEqual(actualCurrentPosition, knownCurrentPosition)
      ? knownCurrentPosition
      : actualCurrentPosition;

  if (arePositionsEqual(currentPosition, targetPosition)) {
    return true; // No change needed
  }

  try {
    const model = editor.getModel();
    if (!model) return false;

    // Validate and clamp the position
    const lineCount = model.getLineCount();
    const safeLineNumber = Math.min(Math.max(targetPosition.lineNumber, 1), lineCount);
    const lineLength = model.getLineLength(safeLineNumber);
    const maxColumn = Math.max(1, lineLength + 1);
    const validPosition = {
      lineNumber: safeLineNumber,
      column: Math.min(Math.max(targetPosition.column, 1), maxColumn),
    };

    editor.setPosition(validPosition);
    return true;
  } catch (error) {
    console.warn("Error applying position diff:", error);
    return false;
  }
};

/**
 * Applies selection only if it has changed
 */
export const applySelectionDiff = (
  editor: monaco.editor.IStandaloneCodeEditor,
  targetSelection: EditorSelection,
  knownCurrentSelection?: EditorSelection | null,
): boolean => {
  const actualCurrentSelection = editor.getSelection();
  const currentSelection =
    knownCurrentSelection !== undefined &&
    areSelectionsEqual(actualCurrentSelection, knownCurrentSelection)
      ? knownCurrentSelection
      : actualCurrentSelection;

  if (areSelectionsEqual(currentSelection, targetSelection)) {
    return true; // No change needed
  }

  try {
    const model = editor.getModel();
    if (!model) return false;

    // Validate the selection bounds
    const lineCount = model.getLineCount();

    const validatePosition = (lineNumber: number, column: number) => {
      const safeLineNumber = Math.min(Math.max(lineNumber, 1), lineCount);
      const lineLength = model.getLineLength(safeLineNumber);
      const maxColumn = Math.max(1, lineLength + 1);
      return {
        lineNumber: safeLineNumber,
        column: Math.min(Math.max(column, 1), maxColumn),
      };
    };

    const validSelectionStart = validatePosition(
      targetSelection.selectionStartLineNumber,
      targetSelection.selectionStartColumn,
    );
    const validPosition = validatePosition(
      targetSelection.positionLineNumber,
      targetSelection.positionColumn,
    );

    const validSelection = {
      startLineNumber: validSelectionStart.lineNumber,
      startColumn: validSelectionStart.column,
      endLineNumber: validPosition.lineNumber,
      endColumn: validPosition.column,
      selectionStartLineNumber: validSelectionStart.lineNumber,
      selectionStartColumn: validSelectionStart.column,
      positionLineNumber: validPosition.lineNumber,
      positionColumn: validPosition.column,
    } as monaco.IRange & monaco.ISelection;

    editor.setSelection(validSelection);
    return true;
  } catch (error) {
    console.warn("Error applying selection diff:", error);
    return false;
  }
};

/**
 * Rewrites the model to `targetContent` with one edit that spans only the part that
 * differs. The edit goes through `applyEdits`, not `pushEditOperations`: replayed
 * content is the recording's history, not the viewer's edits, so it must stay off
 * the model's undo stack. There it merged into one element, and Ctrl+Z after a
 * lesson ended rewound the editor to the lesson's opening code.
 *
 * Replay therefore adds no undo history, so a model that can undo holds the
 * viewer's own typing (an ended lesson's playback model stays editable). Those
 * elements store offsets into the text they were typed in, `applyEdits` leaves
 * them in place, and Monaco's undo applies them without checking, so Ctrl+Z after
 * the rewrite would splice old text in at stale offsets. Such a model gets
 * `setValue`, which replaces the content and clears that history.
 */
export const applyContentDiff = (
  editor: monaco.editor.IStandaloneCodeEditor,
  targetContent: string,
  knownCurrentContent?: string | null,
): boolean => {
  const model = editor.getModel();
  if (!model) return false;

  const actualCurrentContent = model.getValue();
  const currentContent =
    knownCurrentContent !== undefined &&
    knownCurrentContent !== null &&
    actualCurrentContent === knownCurrentContent
      ? knownCurrentContent
      : actualCurrentContent;

  // If content is identical, no need to apply any operations
  if (currentContent === targetContent) {
    return true;
  }

  if (model.canUndo()) {
    model.setValue(targetContent);
    return true;
  }

  try {
    // Find the common prefix and suffix to minimize the edit range.
    const commonPrefix = findCommonPrefixJS(currentContent, targetContent);
    const commonSuffix = findCommonSuffixJS(
      currentContent.slice(commonPrefix),
      targetContent.slice(commonPrefix),
    );

    const currentMiddle = currentContent.slice(commonPrefix, currentContent.length - commonSuffix);
    const targetMiddle = targetContent.slice(commonPrefix, targetContent.length - commonSuffix);

    // If only the middle part differs, create a single edit operation
    if (commonPrefix > 0 || commonSuffix > 0 || currentMiddle !== targetMiddle) {
      const startPos = model.getPositionAt(commonPrefix);
      const endPos = model.getPositionAt(commonPrefix + currentMiddle.length);

      const editOperation: monaco.editor.IIdentifiedSingleEditOperation = {
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        text: targetMiddle,
        forceMoveMarkers: true,
      };

      model.applyEdits([editOperation]);
      return true;
    }

    return true;
  } catch (error) {
    console.warn("Error applying content diff:", error);
    // Fall back to setValue if the edit is rejected
    try {
      model.setValue(targetContent);
      return true;
    } catch (fallbackError) {
      console.warn("Fallback setValue also failed:", fallbackError);
      return false;
    }
  }
};

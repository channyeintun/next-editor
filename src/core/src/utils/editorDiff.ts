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
 * Calculates the minimal edit operations needed to transform the current content
 * to the target content and applies them using pushEditOperations
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

      // Apply the edit operation
      model.pushEditOperations([], [editOperation], () => null);
      return true;
    }

    return true;
  } catch (error) {
    console.warn("Error applying content diff:", error);
    // Fallback to setValue if pushEditOperations fails
    try {
      model.setValue(targetContent);
      return true;
    } catch (fallbackError) {
      console.warn("Fallback setValue also failed:", fallbackError);
      return false;
    }
  }
};

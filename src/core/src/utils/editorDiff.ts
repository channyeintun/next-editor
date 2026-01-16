import * as monaco from 'monaco-editor';

/**
 * Checks if two positions are equal
 */
function arePositionsEqual(pos1: monaco.IPosition | null, pos2: monaco.IPosition | null): boolean {
  if (!pos1 || !pos2) return pos1 === pos2;
  return pos1.lineNumber === pos2.lineNumber && pos1.column === pos2.column;
}

/**
 * Checks if two selections are equal
 */
function areSelectionsEqual(sel1: monaco.Selection | null, sel2: monaco.Selection | null): boolean {
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
  targetPosition: monaco.IPosition
): boolean => {
  const currentPosition = editor.getPosition();
  
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
      column: Math.min(Math.max(targetPosition.column, 1), maxColumn)
    };

    editor.setPosition(validPosition);
    return true;
  } catch (error) {
    console.warn('Error applying position diff:', error);
    return false;
  }
};

/**
 * Applies selection only if it has changed
 */
export const applySelectionDiff = (
  editor: monaco.editor.IStandaloneCodeEditor,
  targetSelection: monaco.Selection
): boolean => {
  const currentSelection = editor.getSelection();
  
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
        column: Math.min(Math.max(column, 1), maxColumn)
      };
    };

    const validSelectionStart = validatePosition(targetSelection.selectionStartLineNumber, targetSelection.selectionStartColumn);
    const validPosition = validatePosition(targetSelection.positionLineNumber, targetSelection.positionColumn);

    const validSelection = new monaco.Selection(
      validSelectionStart.lineNumber,
      validSelectionStart.column,
      validPosition.lineNumber,
      validPosition.column
    );

    editor.setSelection(validSelection);
    return true;
  } catch (error) {
    console.warn('Error applying selection diff:', error);
    return false;
  }
};

/**
 * Calculates the minimal edit operations needed to transform the current content
 * to the target content and applies them using pushEditOperations
 */
export const applyContentDiff = (
  editor: monaco.editor.IStandaloneCodeEditor,
  targetContent: string
): boolean => {
  const model = editor.getModel();
  if (!model) return false;

  const currentContent = model.getValue();
  
  // If content is identical, no need to apply any operations
  if (currentContent === targetContent) {
    return true;
  }

  try {
    // Find the common prefix and suffix to minimize the edit range
    const commonPrefix = findCommonPrefix(currentContent, targetContent);
    const commonSuffix = findCommonSuffix(
      currentContent.slice(commonPrefix),
      targetContent.slice(commonPrefix)
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
          endColumn: endPos.column
        },
        text: targetMiddle,
        forceMoveMarkers: true
      };

      // Apply the edit operation
      model.pushEditOperations([], [editOperation], () => null);
      return true;
    }

    return true;
  } catch (error) {
    console.warn('Error applying content diff:', error);
    // Fallback to setValue if pushEditOperations fails
    try {
      model.setValue(targetContent);
      return true;
    } catch (fallbackError) {
      console.warn('Fallback setValue also failed:', fallbackError);
      return false;
    }
  }
};

/**
 * Finds the length of the common prefix between two strings
 */
function findCommonPrefix(str1: string, str2: string): number {
  let i = 0;
  const minLength = Math.min(str1.length, str2.length);
  
  while (i < minLength && str1[i] === str2[i]) {
    i++;
  }
  
  return i;
}

/**
 * Finds the length of the common suffix between two strings
 */
function findCommonSuffix(str1: string, str2: string): number {
  let i = 0;
  const minLength = Math.min(str1.length, str2.length);
  
  while (i < minLength && str1[str1.length - 1 - i] === str2[str2.length - 1 - i]) {
    i++;
  }
  
  return i;
}
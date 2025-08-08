import type * as monaco from 'monaco-editor';

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
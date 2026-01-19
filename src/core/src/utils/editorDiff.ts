import * as monaco from 'monaco-editor';
import { getWasmExports } from './steganography';
import type { EditorPosition, EditorSelection } from '../types';

/**
 * Checks if two positions are equal
 */
function arePositionsEqual(pos1: EditorPosition | null, pos2: EditorPosition | null): boolean {
  if (!pos1 || !pos2) return pos1 === pos2;
  return pos1.lineNumber === pos2.lineNumber && pos1.column === pos2.column;
}

/**
 * Checks if two selections are equal
 */
function areSelectionsEqual(sel1: EditorSelection | null, sel2: EditorSelection | null): boolean {
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
  targetPosition: EditorPosition
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
  targetSelection: EditorSelection
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
    // Find the common prefix and suffix to minimize the edit range (using Wasm)
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

// Cached encoder/decoder for string↔bytes conversion
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Finds the length of the common prefix between two strings using WebAssembly.
 * Requires Wasm to be initialized via initWasm().
 */
function findCommonPrefix(str1: string, str2: string): number {
  const exports = getWasmExports();
  if (!exports) {
    throw new Error('Wasm not initialized. Call initWasm() first.');
  }

  const memory = exports.memory;

  // Encode strings to UTF-8
  const bytes1 = textEncoder.encode(str1);
  const bytes2 = textEncoder.encode(str2);

  // Ensure enough memory
  const totalSize = bytes1.length + bytes2.length;
  if (memory.buffer.byteLength < totalSize) {
    const pagesNeeded = Math.ceil((totalSize - memory.buffer.byteLength) / 65536);
    if (pagesNeeded > 0) memory.grow(pagesNeeded);
  }

  // Copy to Wasm memory
  const ptr1 = 0;
  const ptr2 = bytes1.length;

  new Uint8Array(memory.buffer, ptr1, bytes1.length).set(bytes1);
  new Uint8Array(memory.buffer, ptr2, bytes2.length).set(bytes2);

  // Call Wasm function
  const prefixBytes = exports.findCommonPrefix(ptr1, bytes1.length, ptr2, bytes2.length);

  // Convert byte count back to character count
  if (prefixBytes === 0) return 0;
  if (prefixBytes === bytes1.length) return str1.length;
  if (prefixBytes === bytes2.length) return str2.length;

  // Decode the prefix portion to get character count
  const prefixSlice = new Uint8Array(memory.buffer, ptr1, prefixBytes);
  return textDecoder.decode(prefixSlice).length;
}

/**
 * Finds the length of the common suffix between two strings using WebAssembly.
 * Requires Wasm to be initialized via initWasm().
 */
function findCommonSuffix(str1: string, str2: string): number {
  const exports = getWasmExports();
  if (!exports) {
    throw new Error('Wasm not initialized. Call initWasm() first.');
  }

  const memory = exports.memory;

  // Encode strings to UTF-8
  const bytes1 = textEncoder.encode(str1);
  const bytes2 = textEncoder.encode(str2);

  // Ensure enough memory
  const totalSize = bytes1.length + bytes2.length;
  if (memory.buffer.byteLength < totalSize) {
    const pagesNeeded = Math.ceil((totalSize - memory.buffer.byteLength) / 65536);
    if (pagesNeeded > 0) memory.grow(pagesNeeded);
  }

  // Copy to Wasm memory
  const ptr1 = 0;
  const ptr2 = bytes1.length;

  new Uint8Array(memory.buffer, ptr1, bytes1.length).set(bytes1);
  new Uint8Array(memory.buffer, ptr2, bytes2.length).set(bytes2);

  // Call Wasm function
  const suffixBytes = exports.findCommonSuffix(ptr1, bytes1.length, ptr2, bytes2.length);

  // Convert byte count back to character count
  if (suffixBytes === 0) return 0;
  if (suffixBytes === bytes1.length) return str1.length;
  if (suffixBytes === bytes2.length) return str2.length;

  // Decode the suffix portion to get character count
  const suffixSlice = new Uint8Array(memory.buffer, ptr1 + bytes1.length - suffixBytes, suffixBytes);
  return textDecoder.decode(suffixSlice).length;
}
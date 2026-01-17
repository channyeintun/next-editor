import type * as monaco from 'monaco-editor';
import type { EditorState } from '../types';

/**
 * Validates that an editor state object has all required properties with correct types
 */
export const isValidEditorState = (state: unknown): state is EditorState => {
  if (!state || typeof state !== 'object') {
    return false;
  }

  const obj = state as Record<string, unknown>;

  // Validate content
  if (obj.content === undefined || obj.content === null) {
    return false;
  }

  // Validate position structure
  if (!obj.position ||
    typeof obj.position !== 'object' ||
    obj.position === null) {
    return false;
  }

  const position = obj.position as Record<string, unknown>;
  if (typeof position.lineNumber !== 'number' ||
    typeof position.column !== 'number' ||
    !isFinite(position.lineNumber) ||
    !isFinite(position.column)) {
    return false;
  }

  // Validate selection structure
  if (!obj.selection ||
    typeof obj.selection !== 'object' ||
    obj.selection === null) {
    return false;
  }

  const selection = obj.selection as Record<string, unknown>;
  if (typeof selection.startLineNumber !== 'number' ||
    typeof selection.startColumn !== 'number' ||
    typeof selection.endLineNumber !== 'number' ||
    typeof selection.endColumn !== 'number' ||
    !isFinite(selection.startLineNumber) ||
    !isFinite(selection.startColumn) ||
    !isFinite(selection.endLineNumber) ||
    !isFinite(selection.endColumn)) {
    return false;
  }

  return true;
};

/**
 * Validates frame state structure from recording data
 */
export const isValidFrameState = (state: unknown): boolean => {
  return isValidEditorState(state);
};

/**
 * Checks if Monaco Editor instance is fully ready for operations
 */
export const isEditorReady = (editor: monaco.editor.IStandaloneCodeEditor | null): boolean => {
  if (!editor) return false;

  try {
    // Check if editor has a model and can perform basic operations
    const model = editor.getModel();
    if (!model) return false;

    // Try to get basic properties - if these throw, editor isn't ready
    model.getLineCount();
    editor.getValue();

    return true;
  } catch {
    // Editor is not ready if any basic operation throws
    return false;
  }
};
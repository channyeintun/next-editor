import type * as monaco from 'monaco-editor';
import type { EditorState } from '../types';

/**
 * Validates that an editor state object has all required properties with correct types
 */
export const isValidEditorState = (state: any): state is EditorState => {
  if (!state || typeof state !== 'object') {
    return false;
  }

  // Validate content
  if (state.content === undefined || state.content === null) {
    return false;
  }

  // Validate position structure
  if (!state.position || 
      typeof state.position.lineNumber !== 'number' || 
      typeof state.position.column !== 'number' ||
      !isFinite(state.position.lineNumber) ||
      !isFinite(state.position.column)) {
    return false;
  }

  // Validate selection structure
  if (!state.selection ||
      typeof state.selection.startLineNumber !== 'number' ||
      typeof state.selection.startColumn !== 'number' ||
      typeof state.selection.endLineNumber !== 'number' ||
      typeof state.selection.endColumn !== 'number' ||
      !isFinite(state.selection.startLineNumber) ||
      !isFinite(state.selection.startColumn) ||
      !isFinite(state.selection.endLineNumber) ||
      !isFinite(state.selection.endColumn)) {
    return false;
  }

  return true;
};

/**
 * Validates snapshot state structure from recording data
 */
export const isValidSnapshotState = (state: any): boolean => {
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
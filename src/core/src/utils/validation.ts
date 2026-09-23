import type * as monaco from "monaco-editor";
import type { EditorState } from "../types";

/**
 * Validates that an editor state object has all required properties with correct types
 */
export const isValidEditorState = (state: unknown): state is EditorState => {
  if (!state || typeof state !== "object") {
    return false;
  }

  const obj = state as Record<string, unknown>;

  // Validate content
  if (obj.content === undefined || obj.content === null) {
    return false;
  }

  // Validate position structure
  if (!obj.position || typeof obj.position !== "object") {
    return false;
  }

  const position = obj.position as Record<string, unknown>;
  if (
    typeof position.lineNumber !== "number" ||
    typeof position.column !== "number" ||
    !isFinite(position.lineNumber) ||
    !isFinite(position.column)
  ) {
    return false;
  }

  // Validate selection structure
  if (!obj.selection || typeof obj.selection !== "object") {
    return false;
  }

  const selection = obj.selection as Record<string, unknown>;
  if (
    typeof selection.startLineNumber !== "number" ||
    typeof selection.startColumn !== "number" ||
    typeof selection.endLineNumber !== "number" ||
    typeof selection.endColumn !== "number" ||
    !isFinite(selection.startLineNumber) ||
    !isFinite(selection.startColumn) ||
    !isFinite(selection.endLineNumber) ||
    !isFinite(selection.endColumn)
  ) {
    return false;
  }

  return true;
};

/**
 * Whether the editor has a model to apply a frame to. Monaco detaches a model as it
 * is disposed (the editor's onWillDispose handler calls setModel(null)), so an
 * attached model is always usable.
 */
export const isEditorReady = (editor: monaco.editor.IStandaloneCodeEditor | null): boolean =>
  editor?.getModel() != null;

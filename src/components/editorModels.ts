import type { Monaco } from "@monaco-editor/react";
import { normalizeWorkspacePath } from "../types/workspace";

const PLAYBACK_MODEL_ROOT = "file:///__next-editor__/playback";
const FILE_URI_PREFIX = "file:///";

export function toMonacoModelPath(workspacePath: string) {
  return `${FILE_URI_PREFIX}${encodeURI(normalizeWorkspacePath(workspacePath))}`;
}

export function toPlaybackModelPath(workspacePath: string) {
  return `${PLAYBACK_MODEL_ROOT}/${encodeURI(
    normalizeWorkspacePath(workspacePath),
  )}`;
}

export function syncPlaybackModel(
  monaco: Monaco,
  workspacePath: string,
  content: string,
  language: string,
  options: { preserveExistingContent?: boolean } = {},
) {
  const uri = monaco.Uri.parse(toPlaybackModelPath(workspacePath));
  const model = monaco.editor.getModel(uri);

  if (!model) {
    return monaco.editor.createModel(content, language, uri);
  }

  if (!options.preserveExistingContent && model.getValue() !== content) {
    model.setValue(content);
  }

  monaco.editor.setModelLanguage(model, language);
  return model;
}

export function workspacePathFromMonacoModelUri(uri: { toString(): string }) {
  const modelUri = uri.toString();

  if (
    !modelUri.startsWith(FILE_URI_PREFIX) ||
    modelUri.startsWith(`${PLAYBACK_MODEL_ROOT}/`)
  ) {
    return null;
  }

  return normalizeWorkspacePath(
    decodeURI(modelUri.slice(FILE_URI_PREFIX.length)),
  );
}

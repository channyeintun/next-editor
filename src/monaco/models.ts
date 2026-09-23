import type { Monaco } from "./runtime";
import { normalizeWorkspacePath } from "../types/workspace";

// Workspace files are `file:///<path>` models. The editor's own scratch buffers
// (playback models, API-client request/response bodies, …) live under Monaco's
// `inmemory` scheme instead, which no workspace path can produce: under a
// `file:///` root, a workspace folder of the same name would share their models.
const INTERNAL_MODEL_ROOT = "inmemory://next-editor/";
const PLAYBACK_MODEL_ROOT = `${INTERNAL_MODEL_ROOT}playback`;
const FILE_URI_PREFIX = "file:///";
type TextModel = ReturnType<Monaco["editor"]["createModel"]>;
const synchronizedWorkspaceContent = new WeakMap<TextModel, string>();

/** Mark a Monaco value as already accepted by workspace state. */
export function acknowledgeWorkspaceModelContent(model: TextModel, content: string): void {
  synchronizedWorkspaceContent.set(model, content);
}

export function toMonacoModelPath(workspacePath: string) {
  return `${FILE_URI_PREFIX}${encodeURI(normalizeWorkspacePath(workspacePath))}`;
}

/** The URI of an internal scratch buffer, e.g. `toInternalModelUri("api-client/body.json")`. */
export function toInternalModelUri(name: string) {
  return `${INTERNAL_MODEL_ROOT}${name}`;
}

export function toPlaybackModelPath(workspacePath: string) {
  return `${PLAYBACK_MODEL_ROOT}/${encodeURI(normalizeWorkspacePath(workspacePath))}`;
}

export function isPlaybackModelUri(uri: { toString(): string }) {
  return uri.toString().startsWith(`${PLAYBACK_MODEL_ROOT}/`);
}

export function disposePlaybackModels(
  monaco: Monaco,
  preservedUri: { toString(): string } | null = null,
) {
  // Compare in Monaco's own serialisation: a path from toPlaybackModelPath keeps
  // `$`, `+`, `@`, … raw where `model.uri.toString()` percent-encodes them.
  const preservedModelUri = preservedUri && monaco.Uri.parse(preservedUri.toString()).toString();

  monaco.editor.getModels().forEach((model) => {
    const modelUri = model.uri.toString();

    if (modelUri.startsWith(`${PLAYBACK_MODEL_ROOT}/`) && modelUri !== preservedModelUri) {
      model.dispose();
    }
  });
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

export function syncWorkspaceModel(
  monaco: Monaco,
  workspacePath: string,
  content: string,
  language: string,
) {
  const uri = monaco.Uri.parse(toMonacoModelPath(workspacePath));
  const existingModel = monaco.editor.getModel(uri);
  const model = existingModel ?? monaco.editor.createModel(content, language, uri);

  if (!existingModel) acknowledgeWorkspaceModelContent(model, content);

  if (model.getLanguageId() !== language) {
    monaco.editor.setModelLanguage(model, language);
  }

  if (synchronizedWorkspaceContent.get(model) !== content) {
    if (model.getValue() !== content) model.setValue(content);
    acknowledgeWorkspaceModelContent(model, content);
  }

  return model;
}

export function workspacePathFromMonacoModelUri(uri: { toString(): string }) {
  const modelUri = uri.toString();

  if (!modelUri.startsWith(FILE_URI_PREFIX)) {
    return null;
  }

  // decodeURIComponent, not decodeURI: Monaco's serialisation percent-encodes
  // `$ + @ & = , ;` in paths, and decodeURI leaves those escapes in place.
  return normalizeWorkspacePath(decodeURIComponent(modelUri.slice(FILE_URI_PREFIX.length)));
}

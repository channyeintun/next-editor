import type { Monaco } from "./runtime";
import { normalizeWorkspacePath } from "../types/workspacePaths";

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

/** The workspace file a playback model replays, or null for any other model. */
export function workspacePathFromPlaybackModelUri(uri: { toString(): string }) {
  const modelUri = uri.toString();
  const playbackPrefix = `${PLAYBACK_MODEL_ROOT}/`;

  if (!modelUri.startsWith(playbackPrefix)) {
    return null;
  }

  // decodeURIComponent, as in workspacePathFromMonacoModelUri below.
  return normalizeWorkspacePath(decodeURIComponent(modelUri.slice(playbackPrefix.length)));
}

/**
 * The URI of the workspace model for the file a playback model replays, as Monaco
 * serialises it (what that model's `uri.toString()` gives), or null for any other
 * model. Compare models through this, not through decoded paths: Monaco rewrites a
 * file URI on the way (a leading `X:` is lowercased as a drive letter), so a path read
 * back from the workspace model need not equal the one read from the playback model.
 */
export function workspaceModelUriFromPlaybackModelUri(
  monaco: Monaco,
  uri: { toString(): string },
): string | null {
  const workspacePath = workspacePathFromPlaybackModelUri(uri);
  return workspacePath === null
    ? null
    : monaco.Uri.parse(toMonacoModelPath(workspacePath)).toString();
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

/**
 * The playback model for `workspacePath`: created with `initialContent`, then
 * owned by replay, which writes the recorded edits into it itself. An existing
 * model therefore keeps its content; only its language follows the file.
 */
export function getOrCreatePlaybackModel(
  monaco: Monaco,
  workspacePath: string,
  initialContent: string,
  language: string,
) {
  const uri = monaco.Uri.parse(toPlaybackModelPath(workspacePath));
  const model = monaco.editor.getModel(uri);

  if (!model) {
    return monaco.editor.createModel(initialContent, language, uri);
  }

  if (model.getLanguageId() !== language) {
    monaco.editor.setModelLanguage(model, language);
  }
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

/**
 * Dispose the workspace models whose file has left the project (deleted, renamed,
 * or a different project loaded) and return their URIs. Nothing else releases
 * them, and Monaco keeps every model alive, in the TypeScript worker's program
 * too, until it is disposed. A model an editor still shows, or one listed in
 * `inUse` (the collaboration binding's), is kept whatever its path.
 */
export function disposeRemovedWorkspaceModels(
  monaco: Monaco,
  projectFiles: Readonly<Record<string, unknown>>,
  inUse: readonly (TextModel | null | undefined)[] = [],
): string[] {
  const disposedUris: string[] = [];

  for (const model of monaco.editor.getModels()) {
    const path = workspacePathFromMonacoModelUri(model.uri);

    if (
      path === null ||
      Object.hasOwn(projectFiles, path) ||
      model.isAttachedToEditor() ||
      inUse.includes(model)
    ) {
      continue;
    }

    disposedUris.push(model.uri.toString());
    model.dispose();
  }

  return disposedUris;
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

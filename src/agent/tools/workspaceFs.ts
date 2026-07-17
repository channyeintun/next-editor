import {
  getParentWorkspacePath,
  normalizeWorkspaceFolderPath,
  normalizeWorkspacePath,
  parseWorkspacePath,
  isWorkspaceTextFile,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import type { WorkspaceStoreInstance } from "../../stores/workspaceStore";

/**
 * Thin helpers over `workspaceStore` — the shared seam every tool (and later the
 * chat recorder) reads/writes through. Mutations go through the same
 * `store.trigger.*` events the editor UI uses, so they land in the existing
 * workspace recording track for free (plan §9.1) and never bypass the store's
 * own invariants (path normalization, folder bookkeeping, dirty-state, etc).
 */

export function getProject(store: WorkspaceStoreInstance): WorkspaceProject | null {
  const context = store.getSnapshot().context;
  return context.isInitialized ? context.project : null;
}

export function readFile(store: WorkspaceStoreInstance, path: string): WorkspaceFile | null {
  const project = getProject(store);
  if (!project) {
    return null;
  }

  return project.files[normalizeWorkspacePath(path)] ?? null;
}

export function exists(store: WorkspaceStoreInstance, path: string): boolean {
  const project = getProject(store);
  if (!project) {
    return false;
  }

  return (
    Boolean(project.files[normalizeWorkspacePath(path)]) ||
    project.folders.includes(normalizeWorkspaceFolderPath(path))
  );
}

export interface WorkspaceDirListing {
  files: WorkspaceFile[];
  folders: string[];
}

/** Immediate children of `path` (default: workspace root), each sorted by path. */
export function listDir(store: WorkspaceStoreInstance, path = ""): WorkspaceDirListing {
  const project = getProject(store);
  if (!project) {
    return { files: [], folders: [] };
  }

  const normalizedFolder = normalizeWorkspaceFolderPath(path);

  const files = Object.values(project.files)
    .filter((file) => getParentWorkspacePath(file.path) === normalizedFolder)
    .sort((left, right) => left.path.localeCompare(right.path));

  const folders = project.folders
    .filter((folderPath) => getParentWorkspacePath(folderPath) === normalizedFolder)
    .sort((left, right) => left.localeCompare(right));

  return { files, folders };
}

export interface WriteFileResult {
  created: boolean;
}

/** Creates the file if it doesn't exist yet, otherwise overwrites its content. */
export function writeFile(
  store: WorkspaceStoreInstance,
  path: string,
  content: string,
): WriteFileResult {
  const normalizedPath = parseWorkspacePath(path);
  const existingFile = readFile(store, normalizedPath);

  if (existingFile) {
    if (!isWorkspaceTextFile(existingFile)) {
      throw new Error(`Cannot overwrite binary file "${normalizedPath}" with text`);
    }
    store.trigger.updateFileContent({ path: normalizedPath, content });
    return { created: false };
  }

  store.trigger.createFile({ path: normalizedPath, content });
  const createdFile = readFile(store, normalizedPath);
  if (
    !createdFile ||
    !isWorkspaceTextFile(createdFile) ||
    createdFile.content !== content ||
    (createdFile.encoding ?? "utf-8") !== "utf-8"
  ) {
    throw new Error(`Cannot create "${normalizedPath}" because it conflicts with another path`);
  }
  return { created: true };
}

/** Generic pass-through to `store.trigger.<event>(payload)`, typed off the store's own event map. */
export function mutate<K extends keyof WorkspaceStoreInstance["trigger"]>(
  store: WorkspaceStoreInstance,
  event: K,
  payload: Parameters<WorkspaceStoreInstance["trigger"][K]>[0],
): void {
  type Payload = Parameters<WorkspaceStoreInstance["trigger"][K]>[0];
  (store.trigger[event] as (p: Payload) => void)(payload);
}

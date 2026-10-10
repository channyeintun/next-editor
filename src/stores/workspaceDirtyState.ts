import {
  areStringArraysEqual,
  areWorkspaceFilesEqual,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";

/** What differs between the workspace and its last saved snapshot. */
export interface WorkspaceDirtyState {
  dirtyFilePaths: string[];
  addedFilePaths: string[];
  modifiedFilePaths: string[];
  deletedFilePaths: string[];
  projectMetadataChanged: boolean;
  folderStructureChanged: boolean;
  hasUnsavedChanges: boolean;
}

export const EMPTY_WORKSPACE_DIRTY_STATE: WorkspaceDirtyState = {
  dirtyFilePaths: [],
  addedFilePaths: [],
  modifiedFilePaths: [],
  deletedFilePaths: [],
  projectMetadataChanged: false,
  folderStructureChanged: false,
  hasUnsavedChanges: false,
};

/** The one rule for whether the workspace has anything left to save. */
export function hasUnsavedChanges(
  dirty: Pick<
    WorkspaceDirtyState,
    "dirtyFilePaths" | "projectMetadataChanged" | "folderStructureChanged"
  >,
): boolean {
  return (
    dirty.dirtyFilePaths.length > 0 || dirty.projectMetadataChanged || dirty.folderStructureChanged
  );
}

export function createDirtyState(
  currentProject: WorkspaceProject,
  savedProject: WorkspaceProject,
): WorkspaceDirtyState {
  const currentPaths = new Set(Object.keys(currentProject.files));
  const savedPaths = new Set(Object.keys(savedProject.files));
  const addedFilePaths = Array.from(currentPaths)
    .filter((path) => !savedPaths.has(path))
    .sort((left, right) => left.localeCompare(right));
  const deletedFilePaths = Array.from(savedPaths)
    .filter((path) => !currentPaths.has(path))
    .sort((left, right) => left.localeCompare(right));
  const modifiedFilePaths = Array.from(currentPaths)
    .filter((path) => {
      const savedFile = savedProject.files[path];
      return savedFile ? !areWorkspaceFilesEqual(currentProject.files[path], savedFile) : false;
    })
    .sort((left, right) => left.localeCompare(right));
  const dirtyFilePaths = Array.from(
    new Set([...addedFilePaths, ...modifiedFilePaths, ...deletedFilePaths]),
  ).sort((left, right) => left.localeCompare(right));
  const folderStructureChanged =
    currentProject.folders.length !== savedProject.folders.length ||
    currentProject.folders.some((folder, index) => folder !== savedProject.folders[index]);
  const projectMetadataChanged =
    currentProject.id !== savedProject.id ||
    currentProject.name !== savedProject.name ||
    currentProject.lessonType !== savedProject.lessonType ||
    currentProject.entryFilePath !== savedProject.entryFilePath;

  return {
    dirtyFilePaths,
    addedFilePaths,
    modifiedFilePaths,
    deletedFilePaths,
    projectMetadataChanged,
    folderStructureChanged,
    hasUnsavedChanges: hasUnsavedChanges({
      dirtyFilePaths,
      projectMetadataChanged,
      folderStructureChanged,
    }),
  };
}

export function areDirtyStatesEqual(
  left: WorkspaceDirtyState,
  right: WorkspaceDirtyState,
): boolean {
  return (
    left.hasUnsavedChanges === right.hasUnsavedChanges &&
    left.projectMetadataChanged === right.projectMetadataChanged &&
    left.folderStructureChanged === right.folderStructureChanged &&
    areStringArraysEqual(left.dirtyFilePaths, right.dirtyFilePaths) &&
    areStringArraysEqual(left.addedFilePaths, right.addedFilePaths) &&
    areStringArraysEqual(left.modifiedFilePaths, right.modifiedFilePaths) &&
    areStringArraysEqual(left.deletedFilePaths, right.deletedFilePaths)
  );
}

function updateSortedPathMembership(paths: string[], path: string, included: boolean): string[] {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (paths[middle].localeCompare(path) < 0) low = middle + 1;
    else high = middle;
  }

  const currentlyIncluded = paths[low] === path;
  if (currentlyIncluded === included) return paths;
  return included
    ? [...paths.slice(0, low), path, ...paths.slice(low)]
    : [...paths.slice(0, low), ...paths.slice(low + 1)];
}

/**
 * The dirty state after one path changed, without rescanning the project.
 * Returns `dirtyState` itself when that path's membership did not change, so
 * a caller can skip emitting.
 */
export function refreshDirtyPath(
  dirtyState: WorkspaceDirtyState,
  path: string,
  { currentFile, savedFile }: { currentFile?: WorkspaceFile; savedFile?: WorkspaceFile },
): WorkspaceDirtyState {
  const isAdded = Boolean(currentFile && !savedFile);
  const isDeleted = Boolean(!currentFile && savedFile);
  const isModified = Boolean(
    currentFile && savedFile && !areWorkspaceFilesEqual(currentFile, savedFile),
  );
  const isDirty = isAdded || isDeleted || isModified;
  const addedFilePaths = updateSortedPathMembership(dirtyState.addedFilePaths, path, isAdded);
  const deletedFilePaths = updateSortedPathMembership(dirtyState.deletedFilePaths, path, isDeleted);
  const modifiedFilePaths = updateSortedPathMembership(
    dirtyState.modifiedFilePaths,
    path,
    isModified,
  );
  const dirtyFilePaths = updateSortedPathMembership(dirtyState.dirtyFilePaths, path, isDirty);

  if (
    addedFilePaths === dirtyState.addedFilePaths &&
    deletedFilePaths === dirtyState.deletedFilePaths &&
    modifiedFilePaths === dirtyState.modifiedFilePaths &&
    dirtyFilePaths === dirtyState.dirtyFilePaths
  ) {
    return dirtyState;
  }

  const nextDirtyState = {
    ...dirtyState,
    addedFilePaths,
    deletedFilePaths,
    modifiedFilePaths,
    dirtyFilePaths,
  };
  return { ...nextDirtyState, hasUnsavedChanges: hasUnsavedChanges(nextDirtyState) };
}

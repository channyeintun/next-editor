import { createContext } from "react";
import { createStore } from "@xstate/store-react";
import type {
  WorkspaceDirtyState,
  WorkspaceEditorState,
  WorkspaceSidebarState,
} from "../contexts/WorkspaceContext";
import {
  areWorkspaceProjectsEqual,
  collectWorkspaceFolders,
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  isWorkspaceTextFile,
  normalizeWorkspaceFolderPath,
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceAssetDescriptor,
  type WorkspaceFileContent,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
  type WorkspaceTreeFile,
} from "../types/workspace";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import { createStarterWorkspaceProject } from "../starters/react";
import {
  DEFAULT_FILE_SIDEBAR_WIDTH,
  getClampedFileSidebarWidth,
  readStoredFileSidebarCollapsed,
} from "../utils/sidebarLayout";
import { startPerformanceSpan } from "../utils/performanceMetrics";
import { applyTextEditEvent, type TextEditEvent } from "../types/textEdit";
import {
  areWorkspaceFilesEqual,
  areWorkspaceTopologiesEqual,
  createWorkspaceFile,
  getDefaultFile,
  hasFilePathConflict,
  hasFolderPathConflict,
  isPathWithinFolder,
  listProjectTreeFiles,
  normalizeProject,
  projectSizeBucket,
  remapCollapsedFolders,
  replacePathPrefix,
} from "./workspaceProjectSupport";

export { normalizeProject, WorkspaceProjectValidationError } from "./workspaceProjectSupport";

export interface StoredWorkspaceSnapshot {
  activeFilePath: string;
  project: WorkspaceProject;
  sidebarWidth?: number;
  /** Legacy v1 generation key; removed after descriptor migration. */
  assetGeneration?: string;
}

export type WorkspaceState =
  | {
      isInitialized: false;
      sidebarWidth: number;
      sidebarCollapsed: boolean;
      collapsedFolders: string[];
      sidebarScrollTop: number;
      workspaceLoadVersion: number;
      projectVersion: number;
      externalProjectVersion: number;
      treeVersion: number;
      previewVersion: number;
      saveVersion: number;
      syncVersion: number;
      lastFileSync: { path: string; revision: number } | null;
      isSaving: boolean;
      saveError: string | null;
    }
  | {
      isInitialized: true;
      project: WorkspaceProject;
      activeFilePath: string;
      collapsedFolders: string[];
      sidebarScrollTop: number;
      sidebarWidth: number;
      sidebarCollapsed: boolean;
      savedSnapshot: StoredWorkspaceSnapshot;
      workspaceLoadVersion: number;
      projectVersion: number;
      externalProjectVersion: number;
      treeVersion: number;
      previewVersion: number;
      saveVersion: number;
      syncVersion: number;
      lastFileSync: { path: string; revision: number } | null;
      isSaving: boolean;
      saveError: string | null;
      editorState: WorkspaceEditorState;
      sidebarState: WorkspaceSidebarState;
      lessonType: WorkspaceLessonType;
      projectName: string;
      fileCount: number;
      dirtyState: WorkspaceDirtyState;
    };

export type InitializedWorkspaceState = Extract<WorkspaceState, { isInitialized: true }>;

export const WORKSPACE_STORAGE_KEY = "next-editor-workspace";

export function cloneWorkspaceSnapshot(snapshot: StoredWorkspaceSnapshot): StoredWorkspaceSnapshot {
  return {
    activeFilePath: snapshot.activeFilePath,
    project: snapshot.project,
    sidebarWidth: snapshot.sidebarWidth,
    assetGeneration: snapshot.assetGeneration,
  };
}

/**
 * Asset descriptors are already lightweight and JSON-serializable. Only legacy
 * inline base64 entries are stripped while a v1 snapshot is being migrated.
 */
export function toPersistedSnapshot(snapshot: StoredWorkspaceSnapshot): StoredWorkspaceSnapshot {
  let strippedAny = false;
  const files: Record<string, WorkspaceFile> = {};

  for (const [path, file] of Object.entries(snapshot.project.files)) {
    if (isLegacyWorkspaceBinaryFile(file) && file.content !== "") {
      files[path] = { ...file, content: "" };
      strippedAny = true;
    } else {
      files[path] = file;
    }
  }

  if (!strippedAny) {
    return snapshot;
  }

  return {
    ...snapshot,
    project: { ...snapshot.project, files },
  };
}

function createDirtyState(
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
    hasUnsavedChanges:
      dirtyFilePaths.length > 0 || projectMetadataChanged || folderStructureChanged,
  };
}

function loadStoredWorkspaceSnapshot(): StoredWorkspaceSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);

    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored) as StoredWorkspaceSnapshot;
    const project = normalizeProject(parsed.project);
    const requestedActiveFilePath = normalizeWorkspacePath(parsed.activeFilePath ?? "");
    const activeFilePath = project.files[requestedActiveFilePath]
      ? requestedActiveFilePath
      : project.entryFilePath;

    // Sidebar width is deliberately not restored from storage; it resets to the
    // default on every reload (see sidebarLayout.ts).
    return {
      activeFilePath,
      project,
      assetGeneration:
        typeof parsed.assetGeneration === "string" ? parsed.assetGeneration : undefined,
    };
  } catch (error) {
    console.warn("Failed to load workspace snapshot:", error);
    return null;
  }
}

function hasPendingRecordingUrl(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const raw = new URLSearchParams(window.location.search).get("url");

  if (!raw) {
    return false;
  }

  try {
    const decoded = decodeURIComponent(raw);
    const pathname = decoded.split(/[?#]/)[0].toLowerCase();
    return pathname.endsWith(".ne");
  } catch {
    return false;
  }
}

export function createInitialWorkspaceSnapshot(): StoredWorkspaceSnapshot | null {
  if (hasPendingRecordingUrl()) {
    return null;
  }

  const storedSnapshot = loadStoredWorkspaceSnapshot();

  if (storedSnapshot) {
    return storedSnapshot;
  }

  const project = createStarterWorkspaceProject();
  return {
    activeFilePath: project.entryFilePath,
    project,
    sidebarWidth: DEFAULT_FILE_SIDEBAR_WIDTH,
  };
}

function createEditorState(
  project: WorkspaceProject,
  activeFilePath: string,
  projectVersion: number,
): WorkspaceEditorState {
  return {
    activeFile: getDefaultFile({
      ...project,
      entryFilePath: activeFilePath,
    }),
    projectVersion,
  };
}

function normalizeCollapsedFolders(folders: string[], collapsedFolders: string[]): string[] {
  const validFolders = new Set(
    folders.map((folderPath) => normalizeWorkspaceFolderPath(folderPath)),
  );
  const nextCollapsedFolders = new Set<string>();

  for (const folderPath of collapsedFolders) {
    const normalizedPath = normalizeWorkspaceFolderPath(folderPath);

    if (normalizedPath && validFolders.has(normalizedPath)) {
      nextCollapsedFolders.add(normalizedPath);
    }
  }

  return Array.from(nextCollapsedFolders).sort((left, right) => left.localeCompare(right));
}

function normalizeSidebarScrollTop(scrollTop: number | undefined): number {
  if (!Number.isFinite(scrollTop)) {
    return 0;
  }

  return Math.max(0, Math.round(scrollTop ?? 0));
}

function normalizeSidebarWidth(width: number | undefined): number {
  if (typeof width === "number" && Number.isFinite(width)) {
    return getClampedFileSidebarWidth(
      width,
      typeof window === "undefined" ? undefined : window.innerWidth,
    );
  }

  return DEFAULT_FILE_SIDEBAR_WIDTH;
}

function createSidebarState(
  project: WorkspaceProject,
  activeFilePath: string,
  collapsedFolders: string[],
  sidebarScrollTop: number,
  sidebarWidth: number,
  treeVersion: number,
  previousState?: WorkspaceSidebarState,
): WorkspaceSidebarState {
  const canReuseTopology = previousState?.treeVersion === treeVersion;
  return {
    activeFilePath,
    files: canReuseTopology ? previousState.files : listProjectTreeFiles(project),
    folders: canReuseTopology ? previousState.folders : project.folders,
    treeVersion,
    collapsedFolders,
    sidebarScrollTop,
    sidebarWidth,
    lessonType: project.lessonType,
    previewFilePath: project.entryFilePath,
  };
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areSidebarFilesEqual(left: WorkspaceTreeFile[], right: WorkspaceTreeFile[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((file, index) => {
    const nextFile = right[index];

    return (
      file.path === nextFile.path &&
      file.name === nextFile.name &&
      file.language === nextFile.language
    );
  });
}

function areEditorStatesEqual(left: WorkspaceEditorState, right: WorkspaceEditorState): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.activeFile.path === right.activeFile.path &&
    left.activeFile.name === right.activeFile.name &&
    left.activeFile.language === right.activeFile.language &&
    left.activeFile.content === right.activeFile.content
  );
}

function areSidebarStatesEqual(left: WorkspaceSidebarState, right: WorkspaceSidebarState): boolean {
  return (
    left.activeFilePath === right.activeFilePath &&
    left.treeVersion === right.treeVersion &&
    left.lessonType === right.lessonType &&
    left.previewFilePath === right.previewFilePath &&
    left.sidebarScrollTop === right.sidebarScrollTop &&
    left.sidebarWidth === right.sidebarWidth &&
    areStringArraysEqual(left.collapsedFolders, right.collapsedFolders) &&
    areStringArraysEqual(left.folders, right.folders) &&
    areSidebarFilesEqual(left.files, right.files)
  );
}

function areDirtyStatesEqual(left: WorkspaceDirtyState, right: WorkspaceDirtyState): boolean {
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

function withRefreshedWorkspaceSlices(state: WorkspaceState): WorkspaceState {
  if (!state.isInitialized) {
    return state;
  }

  const nextCollapsedFolders = normalizeCollapsedFolders(
    state.project.folders,
    state.collapsedFolders,
  );
  const nextEditorState = createEditorState(
    state.project,
    state.activeFilePath,
    state.projectVersion,
  );
  const nextSidebarState = createSidebarState(
    state.project,
    state.activeFilePath,
    nextCollapsedFolders,
    state.sidebarScrollTop,
    state.sidebarWidth,
    state.treeVersion,
    state.sidebarState,
  );

  return {
    ...state,
    collapsedFolders: areStringArraysEqual(state.collapsedFolders, nextCollapsedFolders)
      ? state.collapsedFolders
      : nextCollapsedFolders,
    editorState: areEditorStatesEqual(state.editorState, nextEditorState)
      ? state.editorState
      : nextEditorState,
    sidebarState: areSidebarStatesEqual(state.sidebarState, nextSidebarState)
      ? state.sidebarState
      : nextSidebarState,
    lessonType: state.project.lessonType,
    projectName: state.project.name,
    fileCount: Object.keys(state.project.files).length,
  };
}

function withDirtyState(state: WorkspaceState): WorkspaceState {
  if (!state.isInitialized) {
    return state;
  }

  const nextDirtyState = createDirtyState(state.project, state.savedSnapshot.project);

  if (areDirtyStatesEqual(state.dirtyState, nextDirtyState)) {
    return state;
  }

  return {
    ...state,
    dirtyState: nextDirtyState,
  };
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

function withRefreshedDirtyPath(
  state: InitializedWorkspaceState,
  path: string,
): InitializedWorkspaceState {
  const currentFile = state.project.files[path];
  const savedFile = state.savedSnapshot.project.files[path];
  const isAdded = Boolean(currentFile && !savedFile);
  const isDeleted = Boolean(!currentFile && savedFile);
  const isModified = Boolean(
    currentFile && savedFile && !areWorkspaceFilesEqual(currentFile, savedFile),
  );
  const isDirty = isAdded || isDeleted || isModified;
  const addedFilePaths = updateSortedPathMembership(state.dirtyState.addedFilePaths, path, isAdded);
  const deletedFilePaths = updateSortedPathMembership(
    state.dirtyState.deletedFilePaths,
    path,
    isDeleted,
  );
  const modifiedFilePaths = updateSortedPathMembership(
    state.dirtyState.modifiedFilePaths,
    path,
    isModified,
  );
  const dirtyFilePaths = updateSortedPathMembership(state.dirtyState.dirtyFilePaths, path, isDirty);

  if (
    addedFilePaths === state.dirtyState.addedFilePaths &&
    deletedFilePaths === state.dirtyState.deletedFilePaths &&
    modifiedFilePaths === state.dirtyState.modifiedFilePaths &&
    dirtyFilePaths === state.dirtyState.dirtyFilePaths
  ) {
    return state;
  }

  return {
    ...state,
    dirtyState: {
      ...state.dirtyState,
      addedFilePaths,
      deletedFilePaths,
      modifiedFilePaths,
      dirtyFilePaths,
      hasUnsavedChanges:
        dirtyFilePaths.length > 0 ||
        state.dirtyState.projectMetadataChanged ||
        state.dirtyState.folderStructureChanged,
    },
  };
}

function withUpdatedFileContent(
  context: InitializedWorkspaceState,
  path: string,
  content: string,
): InitializedWorkspaceState {
  const existingFile = context.project.files[path];
  if (!existingFile || !isWorkspaceTextFile(existingFile) || existingFile.content === content) {
    return context;
  }

  const nextFile = { ...existingFile, content };
  const nextContext: InitializedWorkspaceState = {
    ...context,
    project: {
      ...context.project,
      files: {
        ...context.project.files,
        [path]: nextFile,
      },
    },
    editorState:
      context.activeFilePath === path
        ? { activeFile: nextFile, projectVersion: context.editorState.projectVersion }
        : context.editorState,
    previewVersion: context.previewVersion + 1,
    syncVersion: context.syncVersion + 1,
    lastFileSync: { path, revision: context.syncVersion + 1 },
  };
  return withRefreshedDirtyPath(nextContext, path);
}

function createUninitializedWorkspaceState(): WorkspaceState {
  return {
    isInitialized: false,
    sidebarWidth: DEFAULT_FILE_SIDEBAR_WIDTH,
    sidebarCollapsed: readStoredFileSidebarCollapsed(),
    collapsedFolders: [],
    sidebarScrollTop: 0,
    workspaceLoadVersion: 0,
    projectVersion: 0,
    externalProjectVersion: 0,
    treeVersion: 0,
    previewVersion: 0,
    saveVersion: 0,
    syncVersion: 0,
    lastFileSync: null,
    isSaving: false,
    saveError: null,
  };
}

function createWorkspaceState(initialSnapshot: StoredWorkspaceSnapshot): WorkspaceState {
  // The store is also constructed directly by collaboration/agent/test
  // adapters, so enforce the same canonical project boundary here instead of
  // relying solely on the localStorage and WorkspaceProvider callers.
  const project = normalizeProject(initialSnapshot.project);
  const requestedActiveFilePath = normalizeWorkspacePath(initialSnapshot.activeFilePath);
  const activeFilePath = project.files[requestedActiveFilePath]
    ? requestedActiveFilePath
    : project.entryFilePath;
  const savedSnapshot = cloneWorkspaceSnapshot({
    ...initialSnapshot,
    project,
    activeFilePath,
  });
  const collapsedFolders = normalizeCollapsedFolders(project.folders, []);
  const sidebarScrollTop = 0;
  const sidebarWidth = normalizeSidebarWidth(initialSnapshot.sidebarWidth);
  const sidebarCollapsed = readStoredFileSidebarCollapsed();

  return {
    isInitialized: true,
    project,
    activeFilePath,
    collapsedFolders,
    sidebarScrollTop,
    sidebarWidth,
    sidebarCollapsed,
    savedSnapshot,
    workspaceLoadVersion: 0,
    projectVersion: 0,
    externalProjectVersion: 0,
    treeVersion: 0,
    previewVersion: 0,
    saveVersion: 0,
    syncVersion: 0,
    lastFileSync: null,
    isSaving: false,
    saveError: null,
    editorState: createEditorState(project, activeFilePath, 0),
    sidebarState: createSidebarState(
      project,
      activeFilePath,
      collapsedFolders,
      sidebarScrollTop,
      sidebarWidth,
      0,
    ),
    lessonType: project.lessonType,
    projectName: project.name,
    fileCount: Object.keys(project.files).length,
    dirtyState: createDirtyState(project, savedSnapshot.project),
  };
}

export function createWorkspaceStore(initialSnapshot?: StoredWorkspaceSnapshot | null) {
  return createStore({
    context: initialSnapshot
      ? createWorkspaceState(initialSnapshot)
      : createUninitializedWorkspaceState(),
    on: {
      setActiveFilePath: (context, event: { path: string }) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (!context.project.files[normalizedPath] || context.activeFilePath === normalizedPath) {
          return context;
        }

        return withRefreshedWorkspaceSlices({
          ...context,
          activeFilePath: normalizedPath,
        });
      },
      setPreviewFilePath: (context, event: { path: string }) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (
          !context.project.files[normalizedPath] ||
          context.project.entryFilePath === normalizedPath
        ) {
          return context;
        }

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: {
              ...context.project,
              entryFilePath: normalizedPath,
            },
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      setCollapsedFolders: (context, event: { paths: string[] }) => {
        if (!context.isInitialized) {
          return context;
        }
        return withRefreshedWorkspaceSlices({
          ...context,
          collapsedFolders: event.paths,
        });
      },
      setSidebarScrollTop: (context, event: { scrollTop: number }) => {
        if (!context.isInitialized) {
          return context;
        }
        const sidebarScrollTop = normalizeSidebarScrollTop(event.scrollTop);

        if (context.sidebarScrollTop === sidebarScrollTop) {
          return context;
        }

        return withRefreshedWorkspaceSlices({
          ...context,
          sidebarScrollTop,
        });
      },
      setSidebarWidth: (context, event: { width: number }) => {
        if (!context.isInitialized) {
          return context;
        }
        const sidebarWidth = normalizeSidebarWidth(event.width);

        if (context.sidebarWidth === sidebarWidth) {
          return context;
        }

        return withRefreshedWorkspaceSlices({
          ...context,
          sidebarWidth,
        });
      },
      // Viewer-side UI preference only: the file explorer can be toggled at any
      // time (including mid-replay) and is intentionally NOT part of the recorded
      // workspace snapshot, so it never overrides what the viewer chooses.
      setSidebarCollapsed: (context, event: { collapsed: boolean }) => {
        if (!context.isInitialized) {
          return context;
        }
        if (context.sidebarCollapsed === event.collapsed) {
          return context;
        }

        return {
          ...context,
          sidebarCollapsed: event.collapsed,
        };
      },
      createFile: (
        context,
        event: {
          path: string;
          content: WorkspaceFileContent;
          encoding?: WorkspaceFileEncoding;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (!normalizedPath || hasFilePathConflict(context.project, normalizedPath)) {
          return context;
        }

        const file = createWorkspaceFile(normalizedPath, event.content, event.encoding);
        const nextFiles = {
          ...context.project.files,
          [normalizedPath]: file,
        };

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: {
              ...context.project,
              folders: collectWorkspaceFolders(Object.keys(nextFiles), context.project.folders),
              files: nextFiles,
            },
            activeFilePath: normalizedPath,
            treeVersion: context.treeVersion + 1,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      createFolder: (context, event: { path: string }) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspaceFolderPath(event.path);

        if (
          !normalizedPath ||
          hasFolderPathConflict(context.project, normalizedPath) ||
          context.project.folders.includes(normalizedPath)
        ) {
          return context;
        }

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: {
              ...context.project,
              folders: collectWorkspaceFolders(Object.keys(context.project.files), [
                ...context.project.folders,
                normalizedPath,
              ]),
            },
            treeVersion: context.treeVersion + 1,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      renameFile: (
        context,
        event: {
          currentPath: string;
          nextPath: string;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedCurrentPath = normalizeWorkspacePath(event.currentPath);
        const normalizedNextPath = normalizeWorkspacePath(event.nextPath);
        const existingFile = context.project.files[normalizedCurrentPath];

        if (
          !existingFile ||
          !normalizedNextPath ||
          normalizedCurrentPath === normalizedNextPath ||
          hasFilePathConflict(context.project, normalizedNextPath, normalizedCurrentPath)
        ) {
          return context;
        }

        const updatedFile = createWorkspaceFile(
          normalizedNextPath,
          existingFile.content,
          existingFile.encoding,
        );
        const nextFiles = { ...context.project.files };
        delete nextFiles[normalizedCurrentPath];
        nextFiles[normalizedNextPath] = updatedFile;

        const nextProject = {
          ...context.project,
          folders: collectWorkspaceFolders(Object.keys(nextFiles), context.project.folders),
          files: nextFiles,
          entryFilePath:
            context.project.entryFilePath === normalizedCurrentPath
              ? normalizedNextPath
              : context.project.entryFilePath,
        };

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: nextProject,
            activeFilePath:
              context.activeFilePath === normalizedCurrentPath
                ? normalizedNextPath
                : context.activeFilePath,
            treeVersion: context.treeVersion + 1,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      renameFolder: (
        context,
        event: {
          currentPath: string;
          nextPath: string;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedCurrentPath = normalizeWorkspaceFolderPath(event.currentPath);
        const normalizedNextPath = normalizeWorkspaceFolderPath(event.nextPath);

        if (
          !normalizedCurrentPath ||
          !normalizedNextPath ||
          normalizedCurrentPath === normalizedNextPath ||
          !context.project.folders.includes(normalizedCurrentPath) ||
          hasFolderPathConflict(context.project, normalizedNextPath) ||
          context.project.folders.includes(normalizedNextPath) ||
          isPathWithinFolder(normalizedNextPath, normalizedCurrentPath)
        ) {
          return context;
        }

        const nextFiles: Record<string, WorkspaceFile> = {};

        for (const file of Object.values(context.project.files)) {
          const nextFilePath = isPathWithinFolder(file.path, normalizedCurrentPath)
            ? replacePathPrefix(file.path, normalizedCurrentPath, normalizedNextPath)
            : file.path;

          if (nextFiles[nextFilePath]) {
            return context;
          }

          nextFiles[nextFilePath] =
            nextFilePath === file.path
              ? file
              : createWorkspaceFile(nextFilePath, file.content, file.encoding);
        }

        const nextProject = {
          ...context.project,
          folders: collectWorkspaceFolders(
            Object.keys(nextFiles),
            context.project.folders.map((folderPath) =>
              isPathWithinFolder(folderPath, normalizedCurrentPath)
                ? replacePathPrefix(folderPath, normalizedCurrentPath, normalizedNextPath)
                : folderPath,
            ),
          ),
          files: nextFiles,
          entryFilePath: isPathWithinFolder(context.project.entryFilePath, normalizedCurrentPath)
            ? replacePathPrefix(
                context.project.entryFilePath,
                normalizedCurrentPath,
                normalizedNextPath,
              )
            : context.project.entryFilePath,
        };

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: nextProject,
            activeFilePath: isPathWithinFolder(context.activeFilePath, normalizedCurrentPath)
              ? replacePathPrefix(context.activeFilePath, normalizedCurrentPath, normalizedNextPath)
              : context.activeFilePath,
            collapsedFolders: remapCollapsedFolders(
              context.collapsedFolders,
              normalizedCurrentPath,
              normalizedNextPath,
            ),
            treeVersion: context.treeVersion + 1,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      deleteFile: (context, event: { path: string }) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (!context.project.files[normalizedPath]) {
          return context;
        }

        const nextFiles = { ...context.project.files };
        delete nextFiles[normalizedPath];

        if (Object.keys(nextFiles).length === 0) {
          const fallbackProject = createStarterHtmlCssWorkspace();

          return withDirtyState(
            withRefreshedWorkspaceSlices({
              ...context,
              project: fallbackProject,
              activeFilePath: fallbackProject.entryFilePath,
              treeVersion: context.treeVersion + 1,
              previewVersion: context.previewVersion + 1,
              syncVersion: context.syncVersion + 1,
            }),
          );
        }

        const nextProject = {
          ...context.project,
          folders: collectWorkspaceFolders(Object.keys(nextFiles), context.project.folders),
          files: nextFiles,
          entryFilePath: nextFiles[context.project.entryFilePath]
            ? context.project.entryFilePath
            : Object.keys(nextFiles)[0],
        };

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: nextProject,
            activeFilePath: nextFiles[context.activeFilePath]
              ? context.activeFilePath
              : nextProject.entryFilePath,
            treeVersion: context.treeVersion + 1,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      deleteFolder: (context, event: { path: string }) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspaceFolderPath(event.path);

        if (!context.project.folders.includes(normalizedPath)) {
          return context;
        }

        const nextFiles = Object.fromEntries(
          Object.values(context.project.files)
            .filter((file) => !isPathWithinFolder(file.path, normalizedPath))
            .map((file) => [file.path, file]),
        ) as Record<string, WorkspaceFile>;

        if (Object.keys(nextFiles).length === 0) {
          const fallbackProject = createStarterHtmlCssWorkspace();

          return withDirtyState(
            withRefreshedWorkspaceSlices({
              ...context,
              project: fallbackProject,
              activeFilePath: fallbackProject.entryFilePath,
              treeVersion: context.treeVersion + 1,
              previewVersion: context.previewVersion + 1,
              syncVersion: context.syncVersion + 1,
            }),
          );
        }

        const nextEntryFilePath = isPathWithinFolder(context.project.entryFilePath, normalizedPath)
          ? Object.keys(nextFiles)[0]
          : context.project.entryFilePath;

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: {
              ...context.project,
              folders: collectWorkspaceFolders(
                Object.keys(nextFiles),
                context.project.folders.filter(
                  (folderPath) => !isPathWithinFolder(folderPath, normalizedPath),
                ),
              ),
              files: nextFiles,
              entryFilePath: nextEntryFilePath,
            },
            activeFilePath:
              isPathWithinFolder(context.activeFilePath, normalizedPath) ||
              !nextFiles[context.activeFilePath]
                ? nextEntryFilePath
                : context.activeFilePath,
            treeVersion: context.treeVersion + 1,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      applyFileTextEdits: (context, event: TextEditEvent) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspacePath(event.path);
        const existingFile = context.project.files[normalizedPath];
        if (!existingFile || !isWorkspaceTextFile(existingFile)) return context;

        const content = applyTextEditEvent(existingFile.content, {
          ...event,
          path: normalizedPath,
        });
        if (content === null || content === existingFile.content) return context;

        const endUpdateSpan = startPerformanceSpan("workspace.content_update", {
          project_size: projectSizeBucket(context.fileCount),
          source: "incremental",
        });
        const nextContext = withUpdatedFileContent(context, normalizedPath, content);
        endUpdateSpan();
        return nextContext;
      },
      updateFileContent: (
        context,
        event: {
          path: string;
          content: string;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspacePath(event.path);
        const existingFile = context.project.files[normalizedPath];

        if (
          !existingFile ||
          !isWorkspaceTextFile(existingFile) ||
          existingFile.content === event.content
        ) {
          return context;
        }

        const endUpdateSpan = startPerformanceSpan("workspace.content_update", {
          project_size: projectSizeBucket(context.fileCount),
          source: "replacement",
        });
        const nextContext = withUpdatedFileContent(context, normalizedPath, event.content);
        endUpdateSpan();
        return nextContext;
      },
      updateLessonType: (
        context,
        event: {
          lessonType: WorkspaceLessonType;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        if (context.project.lessonType === event.lessonType) {
          return context;
        }

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: {
              ...context.project,
              lessonType: event.lessonType,
            },
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      loadProject: (
        context,
        event: {
          project: WorkspaceProject;
          activeFilePath: string;
          savedSnapshot: StoredWorkspaceSnapshot;
          collapsedFolders?: string[];
          sidebarScrollTop?: number;
          sidebarWidth?: number;
        },
      ) => {
        const baseContext: InitializedWorkspaceState = context.isInitialized
          ? context
          : (createWorkspaceState(event.savedSnapshot) as InitializedWorkspaceState);
        const treeVersion = areWorkspaceTopologiesEqual(baseContext.project, event.project)
          ? baseContext.treeVersion
          : baseContext.treeVersion + 1;
        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...baseContext,
            project: event.project,
            activeFilePath: event.activeFilePath,
            collapsedFolders: event.collapsedFolders ?? [],
            sidebarScrollTop: normalizeSidebarScrollTop(event.sidebarScrollTop),
            sidebarWidth:
              event.sidebarWidth === undefined
                ? baseContext.sidebarWidth
                : normalizeSidebarWidth(event.sidebarWidth),
            savedSnapshot: event.savedSnapshot,
            workspaceLoadVersion: baseContext.workspaceLoadVersion + 1,
            projectVersion: baseContext.projectVersion + 1,
            treeVersion,
            previewVersion: baseContext.previewVersion + 1,
            saveVersion: baseContext.saveVersion + 1,
            syncVersion: baseContext.syncVersion + 1,
            isSaving: false,
            saveError: null,
          }),
        );
      },
      reconcileExternalProject: (context, event: { project: WorkspaceProject }) => {
        if (!context.isInitialized) {
          return context;
        }

        const project = normalizeProject(event.project);

        if (areWorkspaceProjectsEqual(context.project, project)) {
          return context;
        }

        const activeFilePath = project.files[context.activeFilePath]
          ? context.activeFilePath
          : project.entryFilePath;
        const treeVersion = areWorkspaceTopologiesEqual(context.project, project)
          ? context.treeVersion
          : context.treeVersion + 1;

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project,
            activeFilePath,
            projectVersion: context.projectVersion + 1,
            // Marks this project bump as container/collaborator-driven rather than
            // a local user action, so playback UIs can tell the two apart.
            externalProjectVersion: context.externalProjectVersion + 1,
            treeVersion,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      beginSave: (context) => {
        if (!context.isInitialized || (context.isSaving && context.saveError === null)) {
          return context;
        }
        return {
          ...context,
          isSaving: true,
          saveError: null,
        };
      },
      saveFailed: (context, event: { message: string }) => {
        if (!context.isInitialized) {
          return context;
        }
        return {
          ...context,
          isSaving: false,
          saveError: event.message,
        };
      },
      markSaved: (
        context,
        event: {
          snapshot: StoredWorkspaceSnapshot;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        return withDirtyState({
          ...context,
          savedSnapshot: event.snapshot,
          saveVersion: context.saveVersion + 1,
          isSaving: false,
          saveError: null,
        });
      },
      hydrateAssetDescriptors: (
        context,
        event: {
          descriptors: Record<string, WorkspaceAssetDescriptor>;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        // Replace legacy v1 base64 placeholders with v2 descriptors after their
        // bytes have migrated in IndexedDB. Both live and saved snapshots change
        // together, so startup migration does not become a dirty user edit.
        let changed = false;
        const nextFiles = { ...context.project.files };
        const nextSavedFiles = { ...context.savedSnapshot.project.files };

        for (const [path, descriptor] of Object.entries(event.descriptors)) {
          const file = nextFiles[path];

          if (file && isLegacyWorkspaceBinaryFile(file)) {
            nextFiles[path] = { ...file, content: descriptor, encoding: "asset" };
            changed = true;
          }

          const savedFile = nextSavedFiles[path];

          if (savedFile && isLegacyWorkspaceBinaryFile(savedFile)) {
            nextSavedFiles[path] = { ...savedFile, content: descriptor, encoding: "asset" };
          }
        }

        if (!changed) {
          return context;
        }

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: { ...context.project, files: nextFiles },
            savedSnapshot: {
              ...context.savedSnapshot,
              project: { ...context.savedSnapshot.project, files: nextSavedFiles },
            },
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      notifyAssetAvailable: (context, event: { assetId: string }) => {
        if (
          !context.isInitialized ||
          !Object.values(context.project.files).some(
            (file) => isWorkspaceAssetFile(file) && file.content.assetId === event.assetId,
          )
        ) {
          return context;
        }
        return {
          ...context,
          previewVersion: context.previewVersion + 1,
          syncVersion: context.syncVersion + 1,
          lastFileSync: null,
        };
      },
    },
  });
}

export type WorkspaceStoreInstance = ReturnType<typeof createWorkspaceStore>;
export type WorkspaceStoreSnapshot = ReturnType<WorkspaceStoreInstance["getSnapshot"]>;

export const WorkspaceStoreContext = createContext<WorkspaceStoreInstance | null>(null);

const emptyEditorState: WorkspaceEditorState = {
  activeFile: { path: "", name: "", language: "", content: "" },
  projectVersion: 0,
};

const emptySidebarState: WorkspaceSidebarState = {
  activeFilePath: "",
  files: [],
  folders: [],
  treeVersion: 0,
  collapsedFolders: [],
  sidebarScrollTop: 0,
  // Must match the uninitialized context.sidebarWidth (DEFAULT_FILE_SIDEBAR_WIDTH):
  // the outer FileSidebar wrapper reads context.sidebarWidth while the inner panel
  // reads this sidebarState.sidebarWidth, and a mismatch shows as a load-time gap.
  sidebarWidth: DEFAULT_FILE_SIDEBAR_WIDTH,
  lessonType: "html-css",
  previewFilePath: "",
};

const emptyDirtyState: WorkspaceDirtyState = {
  dirtyFilePaths: [],
  addedFilePaths: [],
  modifiedFilePaths: [],
  deletedFilePaths: [],
  projectMetadataChanged: false,
  folderStructureChanged: false,
  hasUnsavedChanges: false,
};

export const selectWorkspaceEditorState = (context: WorkspaceState): WorkspaceEditorState =>
  context.isInitialized ? context.editorState : emptyEditorState;

export const selectWorkspaceSidebarState = (context: WorkspaceState): WorkspaceSidebarState =>
  context.isInitialized ? context.sidebarState : emptySidebarState;

export const selectWorkspaceSidebarWidth = (context: WorkspaceState): number =>
  context.sidebarWidth;

export const selectWorkspaceSidebarCollapsed = (context: WorkspaceState): boolean =>
  context.sidebarCollapsed;

export const selectWorkspaceActiveFilePath = (context: WorkspaceState): string =>
  context.isInitialized ? context.activeFilePath : "";

export const selectWorkspaceLessonType = (context: WorkspaceState): WorkspaceLessonType =>
  context.isInitialized ? context.lessonType : "html-css";

export const selectWorkspaceProjectName = (context: WorkspaceState): string =>
  context.isInitialized ? context.projectName : "Untitled";

export const selectWorkspaceProjectId = (context: WorkspaceState): string =>
  context.isInitialized ? context.project.id : "";

/** Increments only when the store replaces the loaded workspace snapshot. */
export const selectWorkspaceLoadVersion = (context: WorkspaceState): number =>
  context.workspaceLoadVersion;

export const selectWorkspaceProjectVersion = (context: WorkspaceState): number =>
  context.projectVersion;

export const selectWorkspaceExternalProjectVersion = (context: WorkspaceState): number =>
  context.externalProjectVersion;

export const selectWorkspaceTreeVersion = (context: WorkspaceState): number => context.treeVersion;

export const selectWorkspaceFileCount = (context: WorkspaceState): number =>
  context.isInitialized ? context.fileCount : 0;

export const selectWorkspacePreviewVersion = (context: WorkspaceState): number =>
  context.previewVersion;

export const selectWorkspaceDirtyState = (context: WorkspaceState): WorkspaceDirtyState =>
  context.isInitialized ? context.dirtyState : emptyDirtyState;

export const selectWorkspaceSaveVersion = (context: WorkspaceState): number => context.saveVersion;

export const selectWorkspaceSyncVersion = (context: WorkspaceState): number => context.syncVersion;

export const selectWorkspaceIsSaving = (context: WorkspaceState): boolean => context.isSaving;

export const selectWorkspaceSaveError = (context: WorkspaceState): string | null =>
  context.saveError;

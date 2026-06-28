import { createContext } from "react";
import { createStore } from "@xstate/store-react";
import type {
  WorkspaceDirtyState,
  WorkspaceEditorState,
  WorkspaceSidebarState,
} from "../contexts/WorkspaceContext";
import {
  collectWorkspaceFolders,
  DEFAULT_WORKSPACE_ENTRY_PATH,
  getWorkspaceBaseName,
  inferLanguageFromPath,
  normalizeWorkspaceFolderPath,
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import { createStarterWorkspaceProject } from "../starters/react";
import {
  DEFAULT_FILE_SIDEBAR_WIDTH,
  getClampedFileSidebarWidth,
  readStoredFileSidebarCollapsed,
} from "../utils/sidebarLayout";

export interface StoredWorkspaceSnapshot {
  activeFilePath: string;
  project: WorkspaceProject;
  sidebarWidth?: number;
}

export type WorkspaceState =
  | {
      isInitialized: false;
      sidebarWidth: number;
      sidebarCollapsed: boolean;
      collapsedFolders: string[];
      sidebarScrollTop: number;
      projectVersion: number;
      previewVersion: number;
      saveVersion: number;
      syncVersion: number;
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
      projectVersion: number;
      previewVersion: number;
      saveVersion: number;
      syncVersion: number;
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
  };
}

/**
 * Strip binary asset bytes from a snapshot before it goes to localStorage. The
 * heavy bytes are persisted separately in IndexedDB (see workspaceAssetStore),
 * so the localStorage snapshot only carries lightweight file metadata and stays
 * well within the storage quota.
 */
export function toPersistedSnapshot(snapshot: StoredWorkspaceSnapshot): StoredWorkspaceSnapshot {
  let strippedAny = false;
  const files: Record<string, WorkspaceFile> = {};

  for (const [path, file] of Object.entries(snapshot.project.files)) {
    if (file.encoding === "base64" && file.content !== "") {
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

function getDirtyFilePaths(
  currentProject: WorkspaceProject,
  savedProject: WorkspaceProject,
): string[] {
  return Object.values(currentProject.files)
    .filter((file) => {
      const savedFile = savedProject.files[file.path];

      if (!savedFile) {
        return true;
      }

      return savedFile.content !== file.content;
    })
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
}

function createDirtyState(
  currentProject: WorkspaceProject,
  savedProject: WorkspaceProject,
): WorkspaceDirtyState {
  const dirtyFilePaths = getDirtyFilePaths(currentProject, savedProject);

  return {
    dirtyFilePaths,
    hasUnsavedChanges: dirtyFilePaths.length > 0,
  };
}

function getDefaultFile(project: WorkspaceProject): WorkspaceFile {
  return (
    project.files[project.entryFilePath] ??
    project.files[DEFAULT_WORKSPACE_ENTRY_PATH] ??
    Object.values(project.files)[0] ?? {
      path: DEFAULT_WORKSPACE_ENTRY_PATH,
      name: "index.html",
      language: "html",
      content: "",
    }
  );
}

function listProjectFiles(project: WorkspaceProject): WorkspaceFile[] {
  return Object.values(project.files).sort((left, right) => left.path.localeCompare(right.path));
}

function createWorkspaceFile(
  path: string,
  content: string,
  encoding?: WorkspaceFileEncoding,
): WorkspaceFile {
  const normalizedPath = normalizeWorkspacePath(path);

  return {
    path: normalizedPath,
    name: getWorkspaceBaseName(normalizedPath),
    language: inferLanguageFromPath(normalizedPath),
    content,
    ...(encoding && encoding !== "utf-8" ? { encoding } : {}),
  };
}

function isPathWithinFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function replacePathPrefix(path: string, currentPrefix: string, nextPrefix: string): string {
  if (path === currentPrefix) {
    return nextPrefix;
  }

  return `${nextPrefix}${path.slice(currentPrefix.length)}`;
}

function remapCollapsedFolders(
  collapsedFolders: string[],
  currentPrefix: string,
  nextPrefix: string,
): string[] {
  return collapsedFolders.map((folderPath) =>
    isPathWithinFolder(folderPath, currentPrefix)
      ? replacePathPrefix(folderPath, currentPrefix, nextPrefix)
      : folderPath,
  );
}

const KNOWN_LESSON_TYPES: ReadonlySet<WorkspaceLessonType> = new Set([
  "html-css",
  "react",
  "vue",
  "solid",
  "svelte",
  "htmx-express",
  "alpine-express",
  "express-ts",
]);

function inferWorkspaceLessonType(
  project: Pick<WorkspaceProject, "files"> & {
    lessonType?: string;
  },
): WorkspaceLessonType {
  if (project.lessonType && KNOWN_LESSON_TYPES.has(project.lessonType as WorkspaceLessonType)) {
    return project.lessonType as WorkspaceLessonType;
  }

  return project.files["package.json"] || project.files["vite.config.js"] ? "react" : "html-css";
}

export function normalizeProject(project: WorkspaceProject): WorkspaceProject {
  const fallbackProject = createStarterHtmlCssWorkspace();
  const files = Object.keys(project.files).length > 0 ? project.files : fallbackProject.files;
  const defaultFile = getDefaultFile({ ...project, files });
  const lessonType = inferWorkspaceLessonType({ ...project, files });

  return {
    ...project,
    lessonType,
    entryFilePath: files[project.entryFilePath] ? project.entryFilePath : defaultFile.path,
    folders: collectWorkspaceFolders(
      Object.keys(files),
      project.folders ?? fallbackProject.folders,
    ),
    files,
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
    const activeFilePath = project.files[parsed.activeFilePath]
      ? parsed.activeFilePath
      : project.entryFilePath;

    // Sidebar width is deliberately not restored from storage; it resets to the
    // default on every reload (see sidebarLayout.ts).
    return {
      activeFilePath,
      project,
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
): WorkspaceSidebarState {
  return {
    activeFilePath,
    files: listProjectFiles(project),
    folders: project.folders,
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

function areSidebarFilesEqual(left: WorkspaceFile[], right: WorkspaceFile[]): boolean {
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
    areStringArraysEqual(left.dirtyFilePaths, right.dirtyFilePaths)
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

function createUninitializedWorkspaceState(): WorkspaceState {
  return {
    isInitialized: false,
    sidebarWidth: DEFAULT_FILE_SIDEBAR_WIDTH,
    sidebarCollapsed: readStoredFileSidebarCollapsed(),
    collapsedFolders: [],
    sidebarScrollTop: 0,
    projectVersion: 0,
    previewVersion: 0,
    saveVersion: 0,
    syncVersion: 0,
  };
}

function createWorkspaceState(initialSnapshot: StoredWorkspaceSnapshot): WorkspaceState {
  const savedSnapshot = cloneWorkspaceSnapshot(initialSnapshot);
  const project = initialSnapshot.project;
  const activeFilePath = initialSnapshot.activeFilePath;
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
    projectVersion: 0,
    previewVersion: 0,
    saveVersion: 0,
    syncVersion: 0,
    editorState: createEditorState(project, activeFilePath, 0),
    sidebarState: createSidebarState(
      project,
      activeFilePath,
      collapsedFolders,
      sidebarScrollTop,
      sidebarWidth,
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
          content: string;
          encoding?: WorkspaceFileEncoding;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (
          !normalizedPath ||
          context.project.files[normalizedPath] ||
          context.project.folders.includes(normalizedPath)
        ) {
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
          context.project.files[normalizedPath] ||
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
          context.project.files[normalizedNextPath] ||
          context.project.folders.includes(normalizedNextPath)
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
          context.project.files[normalizedNextPath] ||
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
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
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

        if (!existingFile || existingFile.content === event.content) {
          return context;
        }

        return withDirtyState({
          ...context,
          project: {
            ...context.project,
            files: {
              ...context.project.files,
              [normalizedPath]: {
                ...existingFile,
                content: event.content,
              },
            },
          },
          previewVersion: context.previewVersion + 1,
          syncVersion: context.syncVersion + 1,
        });
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
            projectVersion: baseContext.projectVersion + 1,
            previewVersion: baseContext.previewVersion + 1,
            saveVersion: baseContext.saveVersion + 1,
            syncVersion: baseContext.syncVersion + 1,
          }),
        );
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
        });
      },
      hydrateAssetContents: (
        context,
        event: {
          contents: Record<string, string>;
        },
      ) => {
        if (!context.isInitialized) {
          return context;
        }
        // Fill in binary asset bytes loaded asynchronously from IndexedDB after
        // the synchronous localStorage bootstrap. Both the live project and the
        // saved snapshot are updated so this does not register as a dirty edit,
        // and only files still awaiting content are touched (never clobbering a
        // user upload/edit that already landed).
        let changed = false;
        const nextFiles = { ...context.project.files };
        const nextSavedFiles = { ...context.savedSnapshot.project.files };

        for (const [path, content] of Object.entries(event.contents)) {
          if (!content) {
            continue;
          }

          const file = nextFiles[path];

          if (file && file.encoding === "base64" && file.content === "") {
            nextFiles[path] = { ...file, content };
            changed = true;
          }

          const savedFile = nextSavedFiles[path];

          if (savedFile && savedFile.encoding === "base64" && savedFile.content === "") {
            nextSavedFiles[path] = { ...savedFile, content };
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

export const selectWorkspaceProjectVersion = (context: WorkspaceState): number =>
  context.projectVersion;

export const selectWorkspaceFileCount = (context: WorkspaceState): number =>
  context.isInitialized ? context.fileCount : 0;

export const selectWorkspacePreviewVersion = (context: WorkspaceState): number =>
  context.previewVersion;

export const selectWorkspaceDirtyState = (context: WorkspaceState): WorkspaceDirtyState =>
  context.isInitialized ? context.dirtyState : emptyDirtyState;

export const selectWorkspaceSaveVersion = (context: WorkspaceState): number => context.saveVersion;

export const selectWorkspaceSyncVersion = (context: WorkspaceState): number => context.syncVersion;

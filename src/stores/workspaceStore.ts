import { createContext } from "react";
import { createStore } from "@xstate/store-react";
import type {
  WorkspaceDirtyState,
  WorkspaceEditorState,
  WorkspaceSidebarState,
} from "../contexts/WorkspaceContext";
import {
  collectWorkspaceFolders,
  createSingleFileWorkspace,
  createStarterWorkspaceProject,
  DEFAULT_WORKSPACE_ENTRY_PATH,
  DEFAULT_WORKSPACE_FILE_CONTENT,
  getWorkspaceBaseName,
  inferLanguageFromPath,
  normalizeWorkspaceFolderPath,
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";

export interface StoredWorkspaceSnapshot {
  activeFilePath: string;
  project: WorkspaceProject;
}

export interface WorkspaceState {
  project: WorkspaceProject;
  activeFilePath: string;
  collapsedFolders: string[];
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
}

export const WORKSPACE_STORAGE_KEY = "next-editor-workspace";

export function cloneWorkspaceSnapshot(
  snapshot: StoredWorkspaceSnapshot,
): StoredWorkspaceSnapshot {
  return {
    activeFilePath: snapshot.activeFilePath,
    project: snapshot.project,
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
      content: DEFAULT_WORKSPACE_FILE_CONTENT,
    }
  );
}

function listProjectFiles(project: WorkspaceProject): WorkspaceFile[] {
  return Object.values(project.files).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function createWorkspaceFile(path: string, content: string): WorkspaceFile {
  const normalizedPath = normalizeWorkspacePath(path);

  return {
    path: normalizedPath,
    name: getWorkspaceBaseName(normalizedPath),
    language: inferLanguageFromPath(normalizedPath),
    content,
  };
}

function isPathWithinFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function replacePathPrefix(
  path: string,
  currentPrefix: string,
  nextPrefix: string,
): string {
  if (path === currentPrefix) {
    return nextPrefix;
  }

  return `${nextPrefix}${path.slice(currentPrefix.length)}`;
}

function inferWorkspaceLessonType(
  project: Pick<WorkspaceProject, "files"> & {
    lessonType?: string;
  },
): WorkspaceLessonType {
  if (project.lessonType === "html-css") {
    return "html-css";
  }

  if (project.lessonType === "node.js") {
    return "node.js";
  }

  return project.files["package.json"] || project.files["vite.config.js"]
    ? "node.js"
    : "html-css";
}

export function normalizeProject(project: WorkspaceProject): WorkspaceProject {
  const fallbackProject = createSingleFileWorkspace();
  const files =
    Object.keys(project.files).length > 0
      ? project.files
      : fallbackProject.files;
  const defaultFile = getDefaultFile({ ...project, files });
  const lessonType = inferWorkspaceLessonType({ ...project, files });

  return {
    ...project,
    lessonType,
    entryFilePath: files[project.entryFilePath]
      ? project.entryFilePath
      : defaultFile.path,
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

    return {
      activeFilePath,
      project,
    };
  } catch (error) {
    console.warn("Failed to load workspace snapshot:", error);
    return null;
  }
}

export function createInitialWorkspaceSnapshot(): StoredWorkspaceSnapshot {
  const storedSnapshot = loadStoredWorkspaceSnapshot();

  if (storedSnapshot) {
    return storedSnapshot;
  }

  const project = createStarterWorkspaceProject();
  return {
    activeFilePath: project.entryFilePath,
    project,
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

function normalizeCollapsedFolders(
  folders: string[],
  collapsedFolders: string[],
): string[] {
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

  return Array.from(nextCollapsedFolders).sort((left, right) =>
    left.localeCompare(right),
  );
}

function createSidebarState(
  project: WorkspaceProject,
  activeFilePath: string,
  collapsedFolders: string[],
): WorkspaceSidebarState {
  return {
    activeFilePath,
    files: listProjectFiles(project),
    folders: project.folders,
    collapsedFolders,
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

function areSidebarFilesEqual(
  left: WorkspaceFile[],
  right: WorkspaceFile[],
): boolean {
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

function areEditorStatesEqual(
  left: WorkspaceEditorState,
  right: WorkspaceEditorState,
): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.activeFile.path === right.activeFile.path &&
    left.activeFile.name === right.activeFile.name &&
    left.activeFile.language === right.activeFile.language &&
    left.activeFile.content === right.activeFile.content
  );
}

function areSidebarStatesEqual(
  left: WorkspaceSidebarState,
  right: WorkspaceSidebarState,
): boolean {
  return (
    left.activeFilePath === right.activeFilePath &&
    left.lessonType === right.lessonType &&
    left.previewFilePath === right.previewFilePath &&
    areStringArraysEqual(left.collapsedFolders, right.collapsedFolders) &&
    areStringArraysEqual(left.folders, right.folders) &&
    areSidebarFilesEqual(left.files, right.files)
  );
}

function areDirtyStatesEqual(
  left: WorkspaceDirtyState,
  right: WorkspaceDirtyState,
): boolean {
  return (
    left.hasUnsavedChanges === right.hasUnsavedChanges &&
    areStringArraysEqual(left.dirtyFilePaths, right.dirtyFilePaths)
  );
}

function withRefreshedWorkspaceSlices(state: WorkspaceState): WorkspaceState {
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
  );

  return {
    ...state,
    collapsedFolders: areStringArraysEqual(
      state.collapsedFolders,
      nextCollapsedFolders,
    )
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
  const nextDirtyState = createDirtyState(
    state.project,
    state.savedSnapshot.project,
  );

  if (areDirtyStatesEqual(state.dirtyState, nextDirtyState)) {
    return state;
  }

  return {
    ...state,
    dirtyState: nextDirtyState,
  };
}

function createWorkspaceState(
  initialSnapshot: StoredWorkspaceSnapshot,
): WorkspaceState {
  const savedSnapshot = cloneWorkspaceSnapshot(initialSnapshot);
  const project = initialSnapshot.project;
  const activeFilePath = initialSnapshot.activeFilePath;
  const collapsedFolders = normalizeCollapsedFolders(project.folders, []);

  return {
    project,
    activeFilePath,
    collapsedFolders,
    savedSnapshot,
    projectVersion: 0,
    previewVersion: 0,
    saveVersion: 0,
    syncVersion: 0,
    editorState: createEditorState(project, activeFilePath, 0),
    sidebarState: createSidebarState(project, activeFilePath, collapsedFolders),
    lessonType: project.lessonType,
    projectName: project.name,
    fileCount: Object.keys(project.files).length,
    dirtyState: createDirtyState(project, savedSnapshot.project),
  };
}

export function createWorkspaceStore(initialSnapshot: StoredWorkspaceSnapshot) {
  return createStore({
    context: createWorkspaceState(initialSnapshot),
    on: {
      setActiveFilePath: (context, event: { path: string }) => {
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (
          !context.project.files[normalizedPath] ||
          context.activeFilePath === normalizedPath
        ) {
          return context;
        }

        return withRefreshedWorkspaceSlices({
          ...context,
          activeFilePath: normalizedPath,
        });
      },
      setPreviewFilePath: (context, event: { path: string }) => {
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
        return withRefreshedWorkspaceSlices({
          ...context,
          collapsedFolders: event.paths,
        });
      },
      createFile: (
        context,
        event: {
          path: string;
          content: string;
        },
      ) => {
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (
          !normalizedPath ||
          context.project.files[normalizedPath] ||
          context.project.folders.includes(normalizedPath)
        ) {
          return context;
        }

        const file = createWorkspaceFile(normalizedPath, event.content);
        const nextFiles = {
          ...context.project.files,
          [normalizedPath]: file,
        };

        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: {
              ...context.project,
              folders: collectWorkspaceFolders(
                Object.keys(nextFiles),
                context.project.folders,
              ),
              files: nextFiles,
            },
            activeFilePath: normalizedPath,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      createFolder: (context, event: { path: string }) => {
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
              folders: collectWorkspaceFolders(
                Object.keys(context.project.files),
                [...context.project.folders, normalizedPath],
              ),
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
        );
        const nextFiles = { ...context.project.files };
        delete nextFiles[normalizedCurrentPath];
        nextFiles[normalizedNextPath] = updatedFile;

        const nextProject = {
          ...context.project,
          folders: collectWorkspaceFolders(
            Object.keys(nextFiles),
            context.project.folders,
          ),
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
        const normalizedCurrentPath = normalizeWorkspaceFolderPath(
          event.currentPath,
        );
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
          const nextFilePath = isPathWithinFolder(
            file.path,
            normalizedCurrentPath,
          )
            ? replacePathPrefix(
                file.path,
                normalizedCurrentPath,
                normalizedNextPath,
              )
            : file.path;

          if (nextFiles[nextFilePath]) {
            return context;
          }

          nextFiles[nextFilePath] =
            nextFilePath === file.path
              ? file
              : createWorkspaceFile(nextFilePath, file.content);
        }

        const nextProject = {
          ...context.project,
          folders: collectWorkspaceFolders(
            Object.keys(nextFiles),
            context.project.folders.map((folderPath) =>
              isPathWithinFolder(folderPath, normalizedCurrentPath)
                ? replacePathPrefix(
                    folderPath,
                    normalizedCurrentPath,
                    normalizedNextPath,
                  )
                : folderPath,
            ),
          ),
          files: nextFiles,
          entryFilePath: isPathWithinFolder(
            context.project.entryFilePath,
            normalizedCurrentPath,
          )
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
            activeFilePath: isPathWithinFolder(
              context.activeFilePath,
              normalizedCurrentPath,
            )
              ? replacePathPrefix(
                  context.activeFilePath,
                  normalizedCurrentPath,
                  normalizedNextPath,
                )
              : context.activeFilePath,
            previewVersion: context.previewVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      deleteFile: (context, event: { path: string }) => {
        const normalizedPath = normalizeWorkspacePath(event.path);

        if (!context.project.files[normalizedPath]) {
          return context;
        }

        const nextFiles = { ...context.project.files };
        delete nextFiles[normalizedPath];

        if (Object.keys(nextFiles).length === 0) {
          const fallbackProject = createSingleFileWorkspace();

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
          folders: collectWorkspaceFolders(
            Object.keys(nextFiles),
            context.project.folders,
          ),
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
          const fallbackProject = createSingleFileWorkspace();

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

        const nextEntryFilePath = isPathWithinFolder(
          context.project.entryFilePath,
          normalizedPath,
        )
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
                  (folderPath) =>
                    !isPathWithinFolder(folderPath, normalizedPath),
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
          syncVersion: context.syncVersion + 1,
        });
      },
      updateLessonType: (
        context,
        event: {
          lessonType: WorkspaceLessonType;
        },
      ) => {
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
        },
      ) => {
        return withDirtyState(
          withRefreshedWorkspaceSlices({
            ...context,
            project: event.project,
            activeFilePath: event.activeFilePath,
            collapsedFolders: event.collapsedFolders ?? [],
            savedSnapshot: event.savedSnapshot,
            projectVersion: context.projectVersion + 1,
            previewVersion: context.previewVersion + 1,
            saveVersion: context.saveVersion + 1,
            syncVersion: context.syncVersion + 1,
          }),
        );
      },
      markSaved: (
        context,
        event: {
          snapshot: StoredWorkspaceSnapshot;
        },
      ) => {
        return withDirtyState({
          ...context,
          savedSnapshot: event.snapshot,
          saveVersion: context.saveVersion + 1,
        });
      },
    },
  });
}

export type WorkspaceStoreInstance = ReturnType<typeof createWorkspaceStore>;
export type WorkspaceStoreSnapshot = ReturnType<
  WorkspaceStoreInstance["getSnapshot"]
>;

export const WorkspaceStoreContext =
  createContext<WorkspaceStoreInstance | null>(null);

export const selectWorkspaceEditorState = (
  context: WorkspaceState,
): WorkspaceEditorState => context.editorState;

export const selectWorkspaceSidebarState = (
  context: WorkspaceState,
): WorkspaceSidebarState => context.sidebarState;

export const selectWorkspaceActiveFilePath = (
  context: WorkspaceState,
): string => context.activeFilePath;

export const selectWorkspaceLessonType = (
  context: WorkspaceState,
): WorkspaceLessonType => context.lessonType;

export const selectWorkspaceProjectName = (context: WorkspaceState): string =>
  context.projectName;

export const selectWorkspaceProjectVersion = (
  context: WorkspaceState,
): number => context.projectVersion;

export const selectWorkspaceFileCount = (context: WorkspaceState): number =>
  context.fileCount;

export const selectWorkspacePreviewVersion = (
  context: WorkspaceState,
): number => context.previewVersion;

export const selectWorkspaceDirtyState = (
  context: WorkspaceState,
): WorkspaceDirtyState => context.dirtyState;

export const selectWorkspaceSaveVersion = (context: WorkspaceState): number =>
  context.saveVersion;

export const selectWorkspaceSyncVersion = (context: WorkspaceState): number =>
  context.syncVersion;

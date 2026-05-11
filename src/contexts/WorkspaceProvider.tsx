import { useCallback, useMemo, useRef } from "react";
import {
  WorkspaceActionsContext,
  WorkspaceActiveFilePathContext,
  WorkspaceDirtyStateContext,
  WorkspaceEditorStateContext,
  WorkspaceFileCountContext,
  WorkspaceLessonTypeContext,
  WorkspacePreviewVersionContext,
  WorkspaceProjectNameContext,
  WorkspaceSaveVersionContext,
  WorkspaceSidebarStateContext,
  WorkspaceSyncVersionContext,
  type WorkspaceActions,
  type WorkspaceDirtyState,
  type WorkspaceEditorState,
  type WorkspaceSidebarState,
  type WorkspaceStore,
} from "./WorkspaceContext";
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

interface WorkspaceProviderProps {
  children: React.ReactNode;
}

interface StoredWorkspaceSnapshot {
  activeFilePath: string;
  project: WorkspaceProject;
}

const WORKSPACE_STORAGE_KEY = "next-editor-workspace";

function cloneWorkspaceSnapshot(
  snapshot: StoredWorkspaceSnapshot,
): StoredWorkspaceSnapshot {
  return {
    activeFilePath: snapshot.activeFilePath,
    project: structuredClone(snapshot.project),
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

function normalizeProject(project: WorkspaceProject): WorkspaceProject {
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

function createInitialWorkspaceSnapshot(): StoredWorkspaceSnapshot {
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

function createSidebarState(
  project: WorkspaceProject,
  activeFilePath: string,
): WorkspaceSidebarState {
  return {
    activeFilePath,
    files: listProjectFiles(project),
    folders: project.folders,
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
    areStringArraysEqual(left.folders, right.folders) &&
    areSidebarFilesEqual(left.files, right.files)
  );
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
}) => {
  const initialSnapshotRef = useRef<StoredWorkspaceSnapshot>(
    createInitialWorkspaceSnapshot(),
  );
  const savedSnapshotRef = useRef<StoredWorkspaceSnapshot>(
    cloneWorkspaceSnapshot(initialSnapshotRef.current),
  );
  const projectRef = useRef<WorkspaceProject>(
    initialSnapshotRef.current.project,
  );
  const activeFilePathRef = useRef(initialSnapshotRef.current.activeFilePath);
  const projectVersionRef = useRef(0);
  const previewVersionRef = useRef(0);
  const saveVersionRef = useRef(0);
  const syncVersionRef = useRef(0);
  const activeFilePathListenersRef = useRef(new Set<() => void>());
  const editorStateListenersRef = useRef(new Set<() => void>());
  const sidebarStateListenersRef = useRef(new Set<() => void>());
  const lessonTypeListenersRef = useRef(new Set<() => void>());
  const projectNameListenersRef = useRef(new Set<() => void>());
  const fileCountListenersRef = useRef(new Set<() => void>());
  const previewVersionListenersRef = useRef(new Set<() => void>());
  const saveVersionListenersRef = useRef(new Set<() => void>());
  const syncVersionListenersRef = useRef(new Set<() => void>());
  const dirtyStateListenersRef = useRef(new Set<() => void>());
  const activeFilePathStateRef = useRef(activeFilePathRef.current);
  const editorStateRef = useRef<WorkspaceEditorState>(
    createEditorState(
      projectRef.current,
      activeFilePathRef.current,
      projectVersionRef.current,
    ),
  );
  const sidebarStateRef = useRef<WorkspaceSidebarState>(
    createSidebarState(projectRef.current, activeFilePathRef.current),
  );
  const lessonTypeStateRef = useRef(projectRef.current.lessonType);
  const projectNameStateRef = useRef(projectRef.current.name);
  const fileCountStateRef = useRef(
    Object.keys(projectRef.current.files).length,
  );
  const initialDirtyFilePaths = getDirtyFilePaths(
    projectRef.current,
    savedSnapshotRef.current.project,
  );
  const dirtyStateRef = useRef<WorkspaceDirtyState>({
    dirtyFilePaths: initialDirtyFilePaths,
    hasUnsavedChanges: initialDirtyFilePaths.length > 0,
  });

  const notifyListeners = useCallback((listeners: Set<() => void>) => {
    listeners.forEach((listener) => {
      listener();
    });
  }, []);

  const updateDirtyStateStore = useCallback(() => {
    const dirtyFilePaths = getDirtyFilePaths(
      projectRef.current,
      savedSnapshotRef.current.project,
    );
    const nextDirtyState = {
      dirtyFilePaths,
      hasUnsavedChanges: dirtyFilePaths.length > 0,
    } satisfies WorkspaceDirtyState;
    const previousDirtyState = dirtyStateRef.current;
    const didDirtyPathsChange =
      previousDirtyState.dirtyFilePaths.length !== dirtyFilePaths.length ||
      previousDirtyState.dirtyFilePaths.some(
        (path, index) => path !== dirtyFilePaths[index],
      );

    if (
      !didDirtyPathsChange &&
      previousDirtyState.hasUnsavedChanges === nextDirtyState.hasUnsavedChanges
    ) {
      return;
    }

    dirtyStateRef.current = nextDirtyState;
    notifyListeners(dirtyStateListenersRef.current);
  }, [notifyListeners]);

  const updateActiveFilePathStore = useCallback(() => {
    const nextActiveFilePath = activeFilePathRef.current;

    if (activeFilePathStateRef.current === nextActiveFilePath) {
      return;
    }

    activeFilePathStateRef.current = nextActiveFilePath;
    notifyListeners(activeFilePathListenersRef.current);
  }, [notifyListeners]);

  const updateEditorStateStore = useCallback(() => {
    const nextEditorState = createEditorState(
      projectRef.current,
      activeFilePathRef.current,
      projectVersionRef.current,
    );

    if (areEditorStatesEqual(editorStateRef.current, nextEditorState)) {
      return;
    }

    editorStateRef.current = nextEditorState;
    notifyListeners(editorStateListenersRef.current);
  }, [notifyListeners]);

  const updateSidebarStateStore = useCallback(() => {
    const nextSidebarState = createSidebarState(
      projectRef.current,
      activeFilePathRef.current,
    );

    if (areSidebarStatesEqual(sidebarStateRef.current, nextSidebarState)) {
      return;
    }

    sidebarStateRef.current = nextSidebarState;
    notifyListeners(sidebarStateListenersRef.current);
  }, [notifyListeners]);

  const updateLessonTypeStore = useCallback(() => {
    const nextLessonType = projectRef.current.lessonType;

    if (lessonTypeStateRef.current === nextLessonType) {
      return;
    }

    lessonTypeStateRef.current = nextLessonType;
    notifyListeners(lessonTypeListenersRef.current);
  }, [notifyListeners]);

  const updateProjectNameStore = useCallback(() => {
    const nextProjectName = projectRef.current.name;

    if (projectNameStateRef.current === nextProjectName) {
      return;
    }

    projectNameStateRef.current = nextProjectName;
    notifyListeners(projectNameListenersRef.current);
  }, [notifyListeners]);

  const updateFileCountStore = useCallback(() => {
    const nextFileCount = Object.keys(projectRef.current.files).length;

    if (fileCountStateRef.current === nextFileCount) {
      return;
    }

    fileCountStateRef.current = nextFileCount;
    notifyListeners(fileCountListenersRef.current);
  }, [notifyListeners]);

  const refreshWorkspaceStores = useCallback(() => {
    updateActiveFilePathStore();
    updateEditorStateStore();
    updateSidebarStateStore();
    updateLessonTypeStore();
    updateProjectNameStore();
    updateFileCountStore();
  }, [
    updateActiveFilePathStore,
    updateEditorStateStore,
    updateFileCountStore,
    updateLessonTypeStore,
    updateProjectNameStore,
    updateSidebarStateStore,
  ]);

  const bumpProjectVersion = useCallback(() => {
    projectVersionRef.current += 1;
  }, []);

  const bumpSyncVersion = useCallback(() => {
    syncVersionRef.current += 1;
    notifyListeners(syncVersionListenersRef.current);
    updateDirtyStateStore();
  }, [notifyListeners, updateDirtyStateStore]);

  const bumpPreviewVersion = useCallback(() => {
    previewVersionRef.current += 1;
    notifyListeners(previewVersionListenersRef.current);
  }, [notifyListeners]);

  const bumpSaveVersion = useCallback(() => {
    saveVersionRef.current += 1;
    notifyListeners(saveVersionListenersRef.current);
    updateDirtyStateStore();
  }, [notifyListeners, updateDirtyStateStore]);

  const subscribeActiveFilePath = useCallback((listener: () => void) => {
    activeFilePathListenersRef.current.add(listener);

    return () => {
      activeFilePathListenersRef.current.delete(listener);
    };
  }, []);

  const getActiveFilePathSnapshot = useCallback(
    () => activeFilePathStateRef.current,
    [],
  );

  const subscribeEditorState = useCallback((listener: () => void) => {
    editorStateListenersRef.current.add(listener);

    return () => {
      editorStateListenersRef.current.delete(listener);
    };
  }, []);

  const getEditorStateSnapshot = useCallback(() => editorStateRef.current, []);

  const subscribeSidebarState = useCallback((listener: () => void) => {
    sidebarStateListenersRef.current.add(listener);

    return () => {
      sidebarStateListenersRef.current.delete(listener);
    };
  }, []);

  const getSidebarStateSnapshot = useCallback(
    () => sidebarStateRef.current,
    [],
  );

  const subscribeLessonType = useCallback((listener: () => void) => {
    lessonTypeListenersRef.current.add(listener);

    return () => {
      lessonTypeListenersRef.current.delete(listener);
    };
  }, []);

  const getLessonTypeSnapshot = useCallback(() => lessonTypeStateRef.current, []);

  const subscribeProjectName = useCallback((listener: () => void) => {
    projectNameListenersRef.current.add(listener);

    return () => {
      projectNameListenersRef.current.delete(listener);
    };
  }, []);

  const getProjectNameSnapshot = useCallback(
    () => projectNameStateRef.current,
    [],
  );

  const subscribeFileCount = useCallback((listener: () => void) => {
    fileCountListenersRef.current.add(listener);

    return () => {
      fileCountListenersRef.current.delete(listener);
    };
  }, []);

  const getFileCountSnapshot = useCallback(() => fileCountStateRef.current, []);

  const subscribePreviewVersion = useCallback((listener: () => void) => {
    previewVersionListenersRef.current.add(listener);

    return () => {
      previewVersionListenersRef.current.delete(listener);
    };
  }, []);

  const getPreviewVersionSnapshot = useCallback(
    () => previewVersionRef.current,
    [],
  );

  const subscribeSaveVersion = useCallback((listener: () => void) => {
    saveVersionListenersRef.current.add(listener);

    return () => {
      saveVersionListenersRef.current.delete(listener);
    };
  }, []);

  const getSaveVersionSnapshot = useCallback(() => saveVersionRef.current, []);

  const subscribeSyncVersion = useCallback((listener: () => void) => {
    syncVersionListenersRef.current.add(listener);

    return () => {
      syncVersionListenersRef.current.delete(listener);
    };
  }, []);

  const getSyncVersionSnapshot = useCallback(() => syncVersionRef.current, []);

  const subscribeDirtyState = useCallback((listener: () => void) => {
    dirtyStateListenersRef.current.add(listener);

    return () => {
      dirtyStateListenersRef.current.delete(listener);
    };
  }, []);

  const getDirtyStateSnapshot = useCallback(() => dirtyStateRef.current, []);

  const setActiveFilePath = useCallback(
    (path: string) => {
      const normalizedPath = normalizeWorkspacePath(path);

      if (
        !projectRef.current.files[normalizedPath] ||
        activeFilePathRef.current === normalizedPath
      ) {
        return;
      }

      activeFilePathRef.current = normalizedPath;
      refreshWorkspaceStores();
    },
    [refreshWorkspaceStores],
  );

  const setPreviewFilePath = useCallback(
    (path: string) => {
      const normalizedPath = normalizeWorkspacePath(path);

      if (
        !projectRef.current.files[normalizedPath] ||
        projectRef.current.entryFilePath === normalizedPath
      ) {
        return;
      }

      projectRef.current = {
        ...projectRef.current,
        entryFilePath: normalizedPath,
      };

      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const createFile = useCallback(
    (path: string, content = "") => {
      const normalizedPath = normalizeWorkspacePath(path);

      if (
        !normalizedPath ||
        projectRef.current.files[normalizedPath] ||
        projectRef.current.folders.includes(normalizedPath)
      ) {
        return;
      }

      const file = createWorkspaceFile(normalizedPath, content);
      const nextFiles = {
        ...projectRef.current.files,
        [normalizedPath]: file,
      };

      projectRef.current = {
        ...projectRef.current,
        folders: collectWorkspaceFolders(
          Object.keys(nextFiles),
          projectRef.current.folders,
        ),
        files: nextFiles,
      };

      activeFilePathRef.current = normalizedPath;
      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const createFolder = useCallback(
    (path: string) => {
      const normalizedPath = normalizeWorkspaceFolderPath(path);

      if (
        !normalizedPath ||
        projectRef.current.files[normalizedPath] ||
        projectRef.current.folders.includes(normalizedPath)
      ) {
        return;
      }

      projectRef.current = {
        ...projectRef.current,
        folders: collectWorkspaceFolders(
          Object.keys(projectRef.current.files),
          [...projectRef.current.folders, normalizedPath],
        ),
      };

      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const renameFile = useCallback(
    (currentPath: string, nextPath: string) => {
      const normalizedCurrentPath = normalizeWorkspacePath(currentPath);
      const normalizedNextPath = normalizeWorkspacePath(nextPath);
      const existingFile = projectRef.current.files[normalizedCurrentPath];

      if (
        !existingFile ||
        !normalizedNextPath ||
        normalizedCurrentPath === normalizedNextPath ||
        projectRef.current.files[normalizedNextPath] ||
        projectRef.current.folders.includes(normalizedNextPath)
      ) {
        return;
      }

      const updatedFile = createWorkspaceFile(
        normalizedNextPath,
        existingFile.content,
      );
      const nextFiles = { ...projectRef.current.files };
      delete nextFiles[normalizedCurrentPath];
      nextFiles[normalizedNextPath] = updatedFile;

      projectRef.current = {
        ...projectRef.current,
        folders: collectWorkspaceFolders(
          Object.keys(nextFiles),
          projectRef.current.folders,
        ),
        files: nextFiles,
      };

      if (activeFilePathRef.current === normalizedCurrentPath) {
        activeFilePathRef.current = normalizedNextPath;
      }

      if (projectRef.current.entryFilePath === normalizedCurrentPath) {
        projectRef.current = {
          ...projectRef.current,
          entryFilePath: normalizedNextPath,
        };
      }

      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const renameFolder = useCallback(
    (currentPath: string, nextPath: string) => {
      const normalizedCurrentPath = normalizeWorkspaceFolderPath(currentPath);
      const normalizedNextPath = normalizeWorkspaceFolderPath(nextPath);

      if (
        !normalizedCurrentPath ||
        !normalizedNextPath ||
        normalizedCurrentPath === normalizedNextPath ||
        !projectRef.current.folders.includes(normalizedCurrentPath) ||
        projectRef.current.files[normalizedNextPath] ||
        projectRef.current.folders.includes(normalizedNextPath) ||
        isPathWithinFolder(normalizedNextPath, normalizedCurrentPath)
      ) {
        return;
      }

      const nextFiles: Record<string, WorkspaceFile> = {};

      for (const file of Object.values(projectRef.current.files)) {
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
          return;
        }

        nextFiles[nextFilePath] =
          nextFilePath === file.path
            ? file
            : createWorkspaceFile(nextFilePath, file.content);
      }

      const nextFolders = collectWorkspaceFolders(
        Object.keys(nextFiles),
        projectRef.current.folders.map((folderPath) =>
          isPathWithinFolder(folderPath, normalizedCurrentPath)
            ? replacePathPrefix(
                folderPath,
                normalizedCurrentPath,
                normalizedNextPath,
              )
            : folderPath,
        ),
      );
      const nextEntryFilePath = isPathWithinFolder(
        projectRef.current.entryFilePath,
        normalizedCurrentPath,
      )
        ? replacePathPrefix(
            projectRef.current.entryFilePath,
            normalizedCurrentPath,
            normalizedNextPath,
          )
        : projectRef.current.entryFilePath;
      const nextActiveFilePath = isPathWithinFolder(
        activeFilePathRef.current,
        normalizedCurrentPath,
      )
        ? replacePathPrefix(
            activeFilePathRef.current,
            normalizedCurrentPath,
            normalizedNextPath,
          )
        : activeFilePathRef.current;

      projectRef.current = {
        ...projectRef.current,
        folders: nextFolders,
        files: nextFiles,
        entryFilePath: nextEntryFilePath,
      };
      activeFilePathRef.current = nextActiveFilePath;

      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const deleteFile = useCallback(
    (path: string) => {
      const normalizedPath = normalizeWorkspacePath(path);

      if (!projectRef.current.files[normalizedPath]) {
        return;
      }

      const nextFiles = { ...projectRef.current.files };
      delete nextFiles[normalizedPath];

      if (Object.keys(nextFiles).length === 0) {
        const fallbackProject = createSingleFileWorkspace();
        projectRef.current = fallbackProject;
        activeFilePathRef.current = fallbackProject.entryFilePath;
      } else {
        projectRef.current = {
          ...projectRef.current,
          folders: collectWorkspaceFolders(
            Object.keys(nextFiles),
            projectRef.current.folders,
          ),
          files: nextFiles,
          entryFilePath: nextFiles[projectRef.current.entryFilePath]
            ? projectRef.current.entryFilePath
            : Object.keys(nextFiles)[0],
        };

        if (!nextFiles[activeFilePathRef.current]) {
          activeFilePathRef.current = projectRef.current.entryFilePath;
        }
      }

      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const deleteFolder = useCallback(
    (path: string) => {
      const normalizedPath = normalizeWorkspaceFolderPath(path);

      if (!projectRef.current.folders.includes(normalizedPath)) {
        return;
      }

      const nextFiles = Object.fromEntries(
        Object.values(projectRef.current.files)
          .filter((file) => !isPathWithinFolder(file.path, normalizedPath))
          .map((file) => [file.path, file]),
      ) as Record<string, WorkspaceFile>;

      if (Object.keys(nextFiles).length === 0) {
        const fallbackProject = createSingleFileWorkspace();
        projectRef.current = fallbackProject;
        activeFilePathRef.current = fallbackProject.entryFilePath;
      } else {
        const remainingFolders = projectRef.current.folders.filter(
          (folderPath) => !isPathWithinFolder(folderPath, normalizedPath),
        );
        const nextEntryFilePath = isPathWithinFolder(
          projectRef.current.entryFilePath,
          normalizedPath,
        )
          ? Object.keys(nextFiles)[0]
          : projectRef.current.entryFilePath;

        projectRef.current = {
          ...projectRef.current,
          folders: collectWorkspaceFolders(
            Object.keys(nextFiles),
            remainingFolders,
          ),
          files: nextFiles,
          entryFilePath: nextEntryFilePath,
        };

        if (
          isPathWithinFolder(activeFilePathRef.current, normalizedPath) ||
          !nextFiles[activeFilePathRef.current]
        ) {
          activeFilePathRef.current = nextEntryFilePath;
        }
      }

      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const updateFileContent = useCallback(
    (path: string, content: string) => {
      const normalizedPath = normalizeWorkspacePath(path);
      const existingFile = projectRef.current.files[normalizedPath];

      if (!existingFile || existingFile.content === content) {
        return;
      }

      projectRef.current = {
        ...projectRef.current,
        files: {
          ...projectRef.current.files,
          [normalizedPath]: {
            ...existingFile,
            content,
          },
        },
      };
      bumpSyncVersion();
    },
    [bumpSyncVersion],
  );

  const updateActiveFileContent = useCallback(
    (content: string) => {
      updateFileContent(activeFilePathRef.current, content);
    },
    [updateFileContent],
  );

  const saveProject = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({
          activeFilePath: activeFilePathRef.current,
          project: projectRef.current,
        } satisfies StoredWorkspaceSnapshot),
      );
      savedSnapshotRef.current = {
        activeFilePath: activeFilePathRef.current,
        project: structuredClone(projectRef.current),
      };
      bumpSaveVersion();
    } catch (error) {
      console.warn("Failed to save workspace snapshot:", error);
    }
  }, [bumpSaveVersion]);

  const loadProject = useCallback(
    (project: WorkspaceProject, nextActiveFilePath?: string) => {
      const normalizedProject = normalizeProject(project);
      const normalizedNextActiveFilePath = normalizeWorkspacePath(
        nextActiveFilePath ?? "",
      );
      const resolvedActiveFilePath = normalizedProject.files[
        normalizedNextActiveFilePath
      ]
        ? normalizedNextActiveFilePath
        : normalizedProject.entryFilePath;

      projectRef.current = normalizedProject;
      activeFilePathRef.current = resolvedActiveFilePath;
      savedSnapshotRef.current = {
        activeFilePath: resolvedActiveFilePath,
        project: structuredClone(normalizedProject),
      };
      bumpProjectVersion();
      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
      bumpSaveVersion();
    },
    [
      bumpPreviewVersion,
      bumpProjectVersion,
      bumpSaveVersion,
      bumpSyncVersion,
      refreshWorkspaceStores,
    ],
  );

  const createNewEditor = useCallback(() => {
    loadProject(createSingleFileWorkspace());
  }, [loadProject]);

  const resetProject = useCallback(() => {
    loadProject(createStarterWorkspaceProject());
  }, [loadProject]);

  const updateLessonType = useCallback(
    (lessonType: WorkspaceLessonType) => {
      if (projectRef.current.lessonType === lessonType) {
        return;
      }

      projectRef.current = {
        ...projectRef.current,
        lessonType,
      };

      refreshWorkspaceStores();
      bumpPreviewVersion();
      bumpSyncVersion();
    },
    [bumpPreviewVersion, bumpSyncVersion, refreshWorkspaceStores],
  );

  const getProject = useCallback(() => projectRef.current, []);

  const getFile = useCallback((path: string) => {
    return projectRef.current.files[normalizeWorkspacePath(path)] ?? null;
  }, []);

  const listFiles = useCallback(() => {
    return listProjectFiles(projectRef.current);
  }, []);

  const actionsValue = useMemo<WorkspaceActions>(
    () => ({
      setActiveFilePath,
      setPreviewFilePath,
      createNewEditor,
      createFile,
      createFolder,
      deleteFolder,
      renameFile,
      renameFolder,
      deleteFile,
      updateFileContent,
      updateActiveFileContent,
      saveProject,
      loadProject,
      resetProject,
      updateLessonType,
      getProject,
      getFile,
      listFiles,
    }),
    [
      createNewEditor,
      createFile,
      createFolder,
      deleteFolder,
      deleteFile,
      getFile,
      getProject,
      listFiles,
      loadProject,
      renameFile,
      renameFolder,
      resetProject,
      saveProject,
      setActiveFilePath,
      setPreviewFilePath,
      updateLessonType,
      updateActiveFileContent,
      updateFileContent,
    ],
  );

  const activeFilePathStore = useMemo<WorkspaceStore<string>>(
    () => ({
      subscribe: subscribeActiveFilePath,
      getSnapshot: getActiveFilePathSnapshot,
    }),
    [getActiveFilePathSnapshot, subscribeActiveFilePath],
  );

  const editorStateStore = useMemo<WorkspaceStore<WorkspaceEditorState>>(
    () => ({
      subscribe: subscribeEditorState,
      getSnapshot: getEditorStateSnapshot,
    }),
    [getEditorStateSnapshot, subscribeEditorState],
  );

  const sidebarStateStore = useMemo<WorkspaceStore<WorkspaceSidebarState>>(
    () => ({
      subscribe: subscribeSidebarState,
      getSnapshot: getSidebarStateSnapshot,
    }),
    [getSidebarStateSnapshot, subscribeSidebarState],
  );

  const lessonTypeStore = useMemo<WorkspaceStore<WorkspaceLessonType>>(
    () => ({
      subscribe: subscribeLessonType,
      getSnapshot: getLessonTypeSnapshot,
    }),
    [getLessonTypeSnapshot, subscribeLessonType],
  );

  const projectNameStore = useMemo<WorkspaceStore<string>>(
    () => ({
      subscribe: subscribeProjectName,
      getSnapshot: getProjectNameSnapshot,
    }),
    [getProjectNameSnapshot, subscribeProjectName],
  );

  const fileCountStore = useMemo<WorkspaceStore<number>>(
    () => ({
      subscribe: subscribeFileCount,
      getSnapshot: getFileCountSnapshot,
    }),
    [getFileCountSnapshot, subscribeFileCount],
  );

  const previewVersionStore = useMemo<WorkspaceStore<number>>(
    () => ({
      subscribe: subscribePreviewVersion,
      getSnapshot: getPreviewVersionSnapshot,
    }),
    [getPreviewVersionSnapshot, subscribePreviewVersion],
  );

  const dirtyStateStore = useMemo<WorkspaceStore<WorkspaceDirtyState>>(
    () => ({
      subscribe: subscribeDirtyState,
      getSnapshot: getDirtyStateSnapshot,
    }),
    [getDirtyStateSnapshot, subscribeDirtyState],
  );

  const saveVersionStore = useMemo<WorkspaceStore<number>>(
    () => ({
      subscribe: subscribeSaveVersion,
      getSnapshot: getSaveVersionSnapshot,
    }),
    [getSaveVersionSnapshot, subscribeSaveVersion],
  );

  const syncVersionStore = useMemo<WorkspaceStore<number>>(
    () => ({
      subscribe: subscribeSyncVersion,
      getSnapshot: getSyncVersionSnapshot,
    }),
    [getSyncVersionSnapshot, subscribeSyncVersion],
  );

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceEditorStateContext value={editorStateStore}>
        <WorkspaceSidebarStateContext value={sidebarStateStore}>
          <WorkspaceActiveFilePathContext value={activeFilePathStore}>
            <WorkspaceLessonTypeContext value={lessonTypeStore}>
              <WorkspaceProjectNameContext value={projectNameStore}>
                <WorkspaceFileCountContext value={fileCountStore}>
                  <WorkspacePreviewVersionContext value={previewVersionStore}>
                    <WorkspaceDirtyStateContext value={dirtyStateStore}>
                      <WorkspaceSaveVersionContext value={saveVersionStore}>
                        <WorkspaceSyncVersionContext value={syncVersionStore}>
                          {children}
                        </WorkspaceSyncVersionContext>
                      </WorkspaceSaveVersionContext>
                    </WorkspaceDirtyStateContext>
                  </WorkspacePreviewVersionContext>
                </WorkspaceFileCountContext>
              </WorkspaceProjectNameContext>
            </WorkspaceLessonTypeContext>
          </WorkspaceActiveFilePathContext>
        </WorkspaceSidebarStateContext>
      </WorkspaceEditorStateContext>
    </WorkspaceActionsContext>
  );
};
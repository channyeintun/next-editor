import { useCallback, useMemo, useRef, useState } from "react";
import {
  WorkspaceActionsContext,
  WorkspaceMetadataContext,
  type WorkspaceActions,
  type WorkspaceMetadata,
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
  const [activeFilePath, setActiveFilePathState] = useState(
    activeFilePathRef.current,
  );
  const [projectVersion, setProjectVersion] = useState(0);
  const [syncVersion, setSyncVersion] = useState(0);
  const [saveVersion, setSaveVersion] = useState(0);

  const bumpProjectVersion = useCallback(() => {
    setProjectVersion((version) => version + 1);
  }, []);

  const bumpSyncVersion = useCallback(() => {
    setSyncVersion((version) => version + 1);
  }, []);

  const bumpSaveVersion = useCallback(() => {
    setSaveVersion((version) => version + 1);
  }, []);

  const setActiveFilePath = useCallback((path: string) => {
    const normalizedPath = normalizeWorkspacePath(path);

    if (
      !projectRef.current.files[normalizedPath] ||
      activeFilePathRef.current === normalizedPath
    ) {
      return;
    }

    activeFilePathRef.current = normalizedPath;
    setActiveFilePathState(normalizedPath);
  }, []);

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

      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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
      setActiveFilePathState(normalizedPath);
      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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

      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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
        setActiveFilePathState(normalizedNextPath);
      }

      if (projectRef.current.entryFilePath === normalizedCurrentPath) {
        projectRef.current = {
          ...projectRef.current,
          entryFilePath: normalizedNextPath,
        };
      }

      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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

      if (nextActiveFilePath !== activeFilePathRef.current) {
        activeFilePathRef.current = nextActiveFilePath;
        setActiveFilePathState(nextActiveFilePath);
      }

      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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
        setActiveFilePathState(fallbackProject.entryFilePath);
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
          const fallbackPath = projectRef.current.entryFilePath;
          activeFilePathRef.current = fallbackPath;
          setActiveFilePathState(fallbackPath);
        }
      }

      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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
        setActiveFilePathState(fallbackProject.entryFilePath);
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
          setActiveFilePathState(nextEntryFilePath);
        }
      }

      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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
      const resolvedActiveFilePath = normalizedProject.files[
        normalizeWorkspacePath(nextActiveFilePath ?? "")
      ]
        ? normalizeWorkspacePath(nextActiveFilePath ?? "")
        : normalizedProject.entryFilePath;

      projectRef.current = normalizedProject;
      activeFilePathRef.current = resolvedActiveFilePath;
      savedSnapshotRef.current = {
        activeFilePath: resolvedActiveFilePath,
        project: structuredClone(normalizedProject),
      };
      setActiveFilePathState(resolvedActiveFilePath);
      bumpProjectVersion();
      bumpSyncVersion();
      bumpSaveVersion();
    },
    [bumpProjectVersion, bumpSaveVersion, bumpSyncVersion],
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

      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
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

  const activeFile = getDefaultFile({
    ...projectRef.current,
    entryFilePath: activeFilePath,
  });
  const dirtyFilePaths = getDirtyFilePaths(
    projectRef.current,
    savedSnapshotRef.current.project,
  );

  const metadataValue = useMemo<WorkspaceMetadata>(
    () => ({
      activeFilePath,
      activeFile,
      files: listProjectFiles(projectRef.current),
      dirtyFilePaths,
      folders: projectRef.current.folders,
      fileCount: Object.keys(projectRef.current.files).length,
      hasUnsavedChanges: dirtyFilePaths.length > 0,
      projectName: projectRef.current.name,
      lessonType: projectRef.current.lessonType,
      previewFilePath: projectRef.current.entryFilePath,
      projectVersion,
      syncVersion,
      saveVersion,
    }),
    [
      activeFile,
      activeFilePath,
      dirtyFilePaths,
      projectVersion,
      saveVersion,
      syncVersion,
    ],
  );

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceMetadataContext value={metadataValue}>
        {children}
      </WorkspaceMetadataContext>
    </WorkspaceActionsContext>
  );
};

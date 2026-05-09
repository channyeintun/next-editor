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
  type WorkspaceProject,
} from "../types/workspace";

interface WorkspaceProviderProps {
  children: React.ReactNode;
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

function normalizeProject(project: WorkspaceProject): WorkspaceProject {
  const fallbackProject = createSingleFileWorkspace();
  const files =
    Object.keys(project.files).length > 0
      ? project.files
      : fallbackProject.files;
  const defaultFile = getDefaultFile({ ...project, files });

  return {
    ...project,
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

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
}) => {
  const projectRef = useRef<WorkspaceProject>(createStarterWorkspaceProject());
  const activeFilePathRef = useRef(projectRef.current.entryFilePath);
  const [activeFilePath, setActiveFilePathState] = useState(
    activeFilePathRef.current,
  );
  const [projectVersion, setProjectVersion] = useState(0);
  const [syncVersion, setSyncVersion] = useState(0);

  const bumpProjectVersion = useCallback(() => {
    setProjectVersion((version) => version + 1);
  }, []);

  const bumpSyncVersion = useCallback(() => {
    setSyncVersion((version) => version + 1);
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

  const loadProject = useCallback(
    (project: WorkspaceProject) => {
      const normalizedProject = normalizeProject(project);
      projectRef.current = normalizedProject;
      activeFilePathRef.current = normalizedProject.entryFilePath;
      setActiveFilePathState(normalizedProject.entryFilePath);
      bumpProjectVersion();
      bumpSyncVersion();
    },
    [bumpProjectVersion, bumpSyncVersion],
  );

  const resetProject = useCallback(() => {
    loadProject(createStarterWorkspaceProject());
  }, [loadProject]);

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
      createFile,
      createFolder,
      renameFile,
      deleteFile,
      updateFileContent,
      updateActiveFileContent,
      loadProject,
      resetProject,
      getProject,
      getFile,
      listFiles,
    }),
    [
      createFile,
      createFolder,
      deleteFile,
      getFile,
      getProject,
      listFiles,
      loadProject,
      renameFile,
      resetProject,
      setActiveFilePath,
      updateActiveFileContent,
      updateFileContent,
    ],
  );

  const activeFile = getDefaultFile({
    ...projectRef.current,
    entryFilePath: activeFilePath,
  });

  const metadataValue = useMemo<WorkspaceMetadata>(
    () => ({
      activeFilePath,
      activeFile,
      files: listProjectFiles(projectRef.current),
      folders: projectRef.current.folders,
      fileCount: Object.keys(projectRef.current.files).length,
      projectName: projectRef.current.name,
      projectVersion,
      syncVersion,
    }),
    [activeFile, activeFilePath, projectVersion, syncVersion],
  );

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceMetadataContext value={metadataValue}>
        {children}
      </WorkspaceMetadataContext>
    </WorkspaceActionsContext>
  );
};

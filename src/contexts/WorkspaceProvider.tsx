import { useCallback, useMemo, useRef, useState } from "react";
import {
  WorkspaceActionsContext,
  WorkspaceMetadataContext,
  type WorkspaceActions,
  type WorkspaceMetadata,
} from "./WorkspaceContext";
import {
  createSingleFileWorkspace,
  DEFAULT_WORKSPACE_ENTRY_PATH,
  DEFAULT_WORKSPACE_FILE_CONTENT,
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
    files,
  };
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
}) => {
  const projectRef = useRef<WorkspaceProject>(createSingleFileWorkspace());
  const activeFilePathRef = useRef(projectRef.current.entryFilePath);
  const [activeFilePath, setActiveFilePathState] = useState(
    activeFilePathRef.current,
  );
  const [projectVersion, setProjectVersion] = useState(0);

  const setActiveFilePath = useCallback((path: string) => {
    if (!projectRef.current.files[path] || activeFilePathRef.current === path) {
      return;
    }

    activeFilePathRef.current = path;
    setActiveFilePathState(path);
  }, []);

  const updateFileContent = useCallback((path: string, content: string) => {
    const existingFile = projectRef.current.files[path];

    if (!existingFile || existingFile.content === content) {
      return;
    }

    projectRef.current = {
      ...projectRef.current,
      files: {
        ...projectRef.current.files,
        [path]: {
          ...existingFile,
          content,
        },
      },
    };
  }, []);

  const updateActiveFileContent = useCallback(
    (content: string) => {
      updateFileContent(activeFilePathRef.current, content);
    },
    [updateFileContent],
  );

  const loadProject = useCallback((project: WorkspaceProject) => {
    const normalizedProject = normalizeProject(project);
    projectRef.current = normalizedProject;
    activeFilePathRef.current = normalizedProject.entryFilePath;
    setActiveFilePathState(normalizedProject.entryFilePath);
    setProjectVersion((version) => version + 1);
  }, []);

  const resetProject = useCallback(() => {
    loadProject(createSingleFileWorkspace());
  }, [loadProject]);

  const getProject = useCallback(() => projectRef.current, []);

  const getFile = useCallback((path: string) => {
    return projectRef.current.files[path] ?? null;
  }, []);

  const listFiles = useCallback(() => {
    return Object.values(projectRef.current.files);
  }, []);

  const actionsValue = useMemo<WorkspaceActions>(
    () => ({
      setActiveFilePath,
      updateFileContent,
      updateActiveFileContent,
      loadProject,
      resetProject,
      getProject,
      getFile,
      listFiles,
    }),
    [
      getFile,
      getProject,
      listFiles,
      loadProject,
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
      fileCount: Object.keys(projectRef.current.files).length,
      projectName: projectRef.current.name,
      projectVersion,
    }),
    [activeFile, activeFilePath, projectVersion],
  );

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceMetadataContext value={metadataValue}>
        {children}
      </WorkspaceMetadataContext>
    </WorkspaceActionsContext>
  );
};

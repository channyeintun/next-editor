import { useCallback, useMemo, useRef } from "react";
import {
  WorkspaceActionsContext,
  type WorkspaceActions,
} from "./WorkspaceContext";
import {
  WORKSPACE_STORAGE_KEY,
  WorkspaceStoreContext,
  cloneWorkspaceSnapshot,
  createInitialWorkspaceSnapshot,
  createWorkspaceStore,
  normalizeProject,
  type StoredWorkspaceSnapshot,
} from "./workspaceStore";
import {
  createSingleFileWorkspace,
  createStarterWorkspaceProject,
  normalizeWorkspacePath,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";

interface WorkspaceProviderProps {
  children: React.ReactNode;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
}) => {
  const initialSnapshotRef = useRef<StoredWorkspaceSnapshot>(
    createInitialWorkspaceSnapshot(),
  );
  const workspaceStoreRef = useRef(
    createWorkspaceStore(initialSnapshotRef.current),
  );

  const setActiveFilePath = useCallback((path: string) => {
    workspaceStoreRef.current.trigger.setActiveFilePath({ path });
  }, []);

  const setPreviewFilePath = useCallback((path: string) => {
    workspaceStoreRef.current.trigger.setPreviewFilePath({ path });
  }, []);

  const createFile = useCallback((path: string, content = "") => {
    workspaceStoreRef.current.trigger.createFile({ path, content });
  }, []);

  const createFolder = useCallback((path: string) => {
    workspaceStoreRef.current.trigger.createFolder({ path });
  }, []);

  const renameFile = useCallback((currentPath: string, nextPath: string) => {
    workspaceStoreRef.current.trigger.renameFile({
      currentPath,
      nextPath,
    });
  }, []);

  const renameFolder = useCallback((currentPath: string, nextPath: string) => {
    workspaceStoreRef.current.trigger.renameFolder({
      currentPath,
      nextPath,
    });
  }, []);

  const deleteFile = useCallback((path: string) => {
    workspaceStoreRef.current.trigger.deleteFile({ path });
  }, []);

  const deleteFolder = useCallback((path: string) => {
    workspaceStoreRef.current.trigger.deleteFolder({ path });
  }, []);

  const updateFileContent = useCallback((path: string, content: string) => {
    workspaceStoreRef.current.trigger.updateFileContent({
      path,
      content,
    });
  }, []);

  const updateActiveFileContent = useCallback((content: string) => {
    const { activeFilePath } = workspaceStoreRef.current.getSnapshot().context;

    workspaceStoreRef.current.trigger.updateFileContent({
      path: activeFilePath,
      content,
    });
  }, []);

  const saveProject = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const { activeFilePath, project } =
        workspaceStoreRef.current.getSnapshot().context;
      const storedSnapshot = {
        activeFilePath,
        project,
      } satisfies StoredWorkspaceSnapshot;

      window.localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify(storedSnapshot),
      );
      workspaceStoreRef.current.trigger.markSaved({
        snapshot: cloneWorkspaceSnapshot(storedSnapshot),
      });
    } catch (error) {
      console.warn("Failed to save workspace snapshot:", error);
    }
  }, []);

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

      workspaceStoreRef.current.trigger.loadProject({
        project: normalizedProject,
        activeFilePath: resolvedActiveFilePath,
        savedSnapshot: {
          activeFilePath: resolvedActiveFilePath,
          project: structuredClone(normalizedProject),
        },
      });
    },
    [],
  );

  const createNewEditor = useCallback(() => {
    loadProject(createSingleFileWorkspace());
  }, [loadProject]);

  const resetProject = useCallback(() => {
    loadProject(createStarterWorkspaceProject());
  }, [loadProject]);

  const updateLessonType = useCallback((lessonType: WorkspaceLessonType) => {
    workspaceStoreRef.current.trigger.updateLessonType({ lessonType });
  }, []);

  const getProject = useCallback(() => {
    return workspaceStoreRef.current.getSnapshot().context.project;
  }, []);

  const getActiveFilePath = useCallback(() => {
    return workspaceStoreRef.current.getSnapshot().context.activeFilePath;
  }, []);

  const getFile = useCallback((path: string) => {
    return (
      workspaceStoreRef.current.getSnapshot().context.project.files[
        normalizeWorkspacePath(path)
      ] ?? null
    );
  }, []);

  const listFiles = useCallback(() => {
    return workspaceStoreRef.current.getSnapshot().context.sidebarState.files;
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
      getActiveFilePath,
      getFile,
      listFiles,
    }),
    [
      createNewEditor,
      createFile,
      createFolder,
      deleteFolder,
      deleteFile,
      getActiveFilePath,
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

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceStoreContext value={workspaceStoreRef.current}>
        {children}
      </WorkspaceStoreContext>
    </WorkspaceActionsContext>
  );
};

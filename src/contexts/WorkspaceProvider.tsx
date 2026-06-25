import { useCallback, useEffect, useMemo, useRef } from "react";
import { WorkspaceActionsContext, type WorkspaceActions } from "./WorkspaceContext";
import {
  WORKSPACE_STORAGE_KEY,
  WorkspaceStoreContext,
  cloneWorkspaceSnapshot,
  createInitialWorkspaceSnapshot,
  createWorkspaceStore,
  normalizeProject,
  toPersistedSnapshot,
  type StoredWorkspaceSnapshot,
} from "../stores/workspaceStore";
import { loadWorkspaceAssetContents, persistWorkspaceAssets } from "../storage/workspaceAssetStore";
import {
  normalizeWorkspacePath,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import { writeStoredFileSidebarCollapsed } from "../utils/sidebarLayout";

interface WorkspaceProviderProps {
  children: React.ReactNode;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({ children }) => {
  const initialSnapshotRef = useRef<StoredWorkspaceSnapshot | null>(
    createInitialWorkspaceSnapshot(),
  );
  const workspaceStoreRef = useRef(createWorkspaceStore(initialSnapshotRef.current));

  // The synchronous localStorage bootstrap loads binary assets with empty
  // content; hydrate their bytes from IndexedDB and let the store re-sync them
  // into the running preview.
  useEffect(() => {
    let cancelled = false;
    const store = workspaceStoreRef.current;
    const context = store.getSnapshot().context;

    if (!context.isInitialized) {
      return;
    }

    void loadWorkspaceAssetContents(context.project)
      .then((contents) => {
        if (cancelled || Object.keys(contents).length === 0) {
          return;
        }

        store.trigger.hydrateAssetContents({ contents });
      })
      .catch((error) => {
        console.warn("Failed to load workspace assets:", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setActiveFilePath = useCallback((path: string) => {
    workspaceStoreRef.current.trigger.setActiveFilePath({ path });
  }, []);

  const setPreviewFilePath = useCallback((path: string) => {
    workspaceStoreRef.current.trigger.setPreviewFilePath({ path });
  }, []);

  const setCollapsedFolders = useCallback((paths: string[]) => {
    workspaceStoreRef.current.trigger.setCollapsedFolders({ paths });
  }, []);

  const setSidebarScrollTop = useCallback((scrollTop: number) => {
    workspaceStoreRef.current.trigger.setSidebarScrollTop({ scrollTop });
  }, []);

  const setSidebarWidth = useCallback((width: number) => {
    // Width is session-only: not written to storage, so it resets to the default
    // on reload. Recording captures resizes as offsets via handleWorkspaceEvent.
    workspaceStoreRef.current.trigger.setSidebarWidth({ width });
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    workspaceStoreRef.current.trigger.setSidebarCollapsed({ collapsed });
    writeStoredFileSidebarCollapsed(
      workspaceStoreRef.current.getSnapshot().context.sidebarCollapsed,
    );
  }, []);

  const createFile = useCallback((path: string, content = "", encoding?: WorkspaceFileEncoding) => {
    workspaceStoreRef.current.trigger.createFile({ path, content, encoding });
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
    const context = workspaceStoreRef.current.getSnapshot().context;
    if (!context.isInitialized) {
      return;
    }

    workspaceStoreRef.current.trigger.updateFileContent({
      path: context.activeFilePath,
      content,
    });
  }, []);

  const saveProject = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const context = workspaceStoreRef.current.getSnapshot().context;
      if (!context.isInitialized) {
        return;
      }
      const { activeFilePath, project } = context;
      // sidebarWidth is intentionally omitted so it is not persisted across reloads.
      const storedSnapshot = {
        activeFilePath,
        project,
      } satisfies StoredWorkspaceSnapshot;

      // localStorage holds only the lightweight metadata (binary bytes stripped);
      // the heavy asset bytes are persisted to IndexedDB best-effort.
      window.localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify(toPersistedSnapshot(storedSnapshot)),
      );
      void persistWorkspaceAssets(project).catch((error) => {
        console.warn("Failed to persist workspace assets:", error);
      });
      workspaceStoreRef.current.trigger.markSaved({
        snapshot: cloneWorkspaceSnapshot(storedSnapshot),
      });
    } catch (error) {
      console.warn("Failed to save workspace snapshot:", error);
    }
  }, []);

  const loadProject = useCallback(
    (
      project: WorkspaceProject,
      nextActiveFilePath?: string,
      collapsedFolders?: string[],
      sidebarScrollTop?: number,
      sidebarWidth?: number,
    ) => {
      const normalizedProject = normalizeProject(project);
      const normalizedNextActiveFilePath = normalizeWorkspacePath(nextActiveFilePath ?? "");
      const resolvedActiveFilePath = normalizedProject.files[normalizedNextActiveFilePath]
        ? normalizedNextActiveFilePath
        : normalizedProject.entryFilePath;

      const savedSnapshot = cloneWorkspaceSnapshot({
        activeFilePath: resolvedActiveFilePath,
        project: normalizedProject,
        sidebarWidth,
      });

      workspaceStoreRef.current.trigger.loadProject({
        project: normalizedProject,
        activeFilePath: resolvedActiveFilePath,
        collapsedFolders,
        sidebarScrollTop,
        sidebarWidth,
        savedSnapshot,
      });
    },
    [],
  );

  const createNewEditor = useCallback(() => {
    loadProject(createStarterHtmlCssWorkspace());
  }, [loadProject]);

  const updateLessonType = useCallback((lessonType: WorkspaceLessonType) => {
    workspaceStoreRef.current.trigger.updateLessonType({ lessonType });
  }, []);

  const getProject = useCallback(() => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    return context.isInitialized
      ? context.project
      : {
          id: "uninitialized",
          name: "Untitled",
          lessonType: "html-css" as const,
          entryFilePath: "",
          folders: [],
          files: {},
        };
  }, []);

  const getActiveFilePath = useCallback(() => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    return context.isInitialized ? context.activeFilePath : "";
  }, []);

  const getCollapsedFolders = useCallback(() => {
    return workspaceStoreRef.current.getSnapshot().context.collapsedFolders;
  }, []);

  const getSidebarScrollTop = useCallback(() => {
    return workspaceStoreRef.current.getSnapshot().context.sidebarScrollTop;
  }, []);

  const getSidebarWidth = useCallback(() => {
    return workspaceStoreRef.current.getSnapshot().context.sidebarWidth;
  }, []);

  const getFile = useCallback((path: string) => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    if (!context.isInitialized) {
      return null;
    }
    return context.project.files[normalizeWorkspacePath(path)] ?? null;
  }, []);

  const listFiles = useCallback(() => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    return context.isInitialized ? context.sidebarState.files : [];
  }, []);

  const actionsValue = useMemo<WorkspaceActions>(
    () => ({
      setActiveFilePath,
      setPreviewFilePath,
      setCollapsedFolders,
      setSidebarScrollTop,
      setSidebarWidth,
      setSidebarCollapsed,
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
      updateLessonType,
      getProject,
      getActiveFilePath,
      getCollapsedFolders,
      getSidebarScrollTop,
      getSidebarWidth,
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
      getCollapsedFolders,
      getSidebarWidth,
      getSidebarScrollTop,
      getFile,
      getProject,
      listFiles,
      loadProject,
      renameFile,
      renameFolder,
      saveProject,
      setActiveFilePath,
      setCollapsedFolders,
      setSidebarScrollTop,
      setSidebarWidth,
      setSidebarCollapsed,
      setPreviewFilePath,
      updateLessonType,
      updateActiveFileContent,
      updateFileContent,
    ],
  );

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceStoreContext value={workspaceStoreRef.current}>{children}</WorkspaceStoreContext>
    </WorkspaceActionsContext>
  );
};

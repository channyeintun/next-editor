import { useEffect, useRef } from "react";
import {
  WorkspaceActionsContext,
  type WorkspaceActions,
  type WorkspaceSyncMutation,
} from "./WorkspaceContext";
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
import {
  collectBinaryAssetPaths,
  createWorkspaceAssetGeneration,
  loadWorkspaceAssetContents,
  persistWorkspaceAssets,
  pruneWorkspaceAssetGenerations,
} from "../storage/workspaceAssetStore";
import {
  normalizeWorkspacePath,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import { prepareTextEditEvent, type TextEditEvent } from "../types/textEdit";
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
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

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

    void loadWorkspaceAssetContents(context.project, context.savedSnapshot.assetGeneration)
      .then((contents) => {
        if (cancelled || Object.keys(contents).length === 0) {
          return;
        }

        store.trigger.hydrateAssetContents({ contents });
      })
      .catch((error) => {
        if (!cancelled) {
          workspaceStoreRef.current.trigger.saveFailed({
            message:
              error instanceof Error
                ? error.message
                : "The saved binary workspace assets could not be loaded",
          });
        }
        console.warn("Failed to load workspace assets:", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setActiveFilePath = (path: string) => {
    workspaceStoreRef.current.trigger.setActiveFilePath({ path });
  };

  const setPreviewFilePath = (path: string) => {
    workspaceStoreRef.current.trigger.setPreviewFilePath({ path });
  };

  const setCollapsedFolders = (paths: string[]) => {
    workspaceStoreRef.current.trigger.setCollapsedFolders({ paths });
  };

  const setSidebarScrollTop = (scrollTop: number) => {
    workspaceStoreRef.current.trigger.setSidebarScrollTop({ scrollTop });
  };

  const setSidebarWidth = (width: number) => {
    // Width is session-only: not written to storage, so it resets to the default
    // on reload. Recording captures resizes as offsets via handleWorkspaceEvent.
    workspaceStoreRef.current.trigger.setSidebarWidth({ width });
  };

  const setSidebarCollapsed = (collapsed: boolean) => {
    workspaceStoreRef.current.trigger.setSidebarCollapsed({ collapsed });
    writeStoredFileSidebarCollapsed(
      workspaceStoreRef.current.getSnapshot().context.sidebarCollapsed,
    );
  };

  const createFile = (path: string, content = "", encoding?: WorkspaceFileEncoding) => {
    workspaceStoreRef.current.trigger.createFile({ path, content, encoding });
  };

  const createFolder = (path: string) => {
    workspaceStoreRef.current.trigger.createFolder({ path });
  };

  const hydrateAssetContents = (contents: Record<string, string>) => {
    workspaceStoreRef.current.trigger.hydrateAssetContents({ contents });
  };

  const renameFile = (currentPath: string, nextPath: string) => {
    workspaceStoreRef.current.trigger.renameFile({
      currentPath,
      nextPath,
    });
  };

  const renameFolder = (currentPath: string, nextPath: string) => {
    workspaceStoreRef.current.trigger.renameFolder({
      currentPath,
      nextPath,
    });
  };

  const deleteFile = (path: string) => {
    workspaceStoreRef.current.trigger.deleteFile({ path });
  };

  const deleteFolder = (path: string) => {
    workspaceStoreRef.current.trigger.deleteFolder({ path });
  };

  const updateFileContent = (path: string, content: string) => {
    workspaceStoreRef.current.trigger.updateFileContent({
      path,
      content,
    });
  };

  const applyFileTextEdits = (event: TextEditEvent): string | null => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    if (!context.isInitialized) return null;

    const path = normalizeWorkspacePath(event.path);
    const file = context.project.files[path];
    if (!file || file.encoding === "base64" || !prepareTextEditEvent(event, file.content.length)) {
      return null;
    }

    workspaceStoreRef.current.trigger.applyFileTextEdits({ ...event, path });
    const nextContext = workspaceStoreRef.current.getSnapshot().context;
    return nextContext.isInitialized ? (nextContext.project.files[path]?.content ?? null) : null;
  };

  const updateActiveFileContent = (content: string) => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    if (!context.isInitialized) {
      return;
    }

    workspaceStoreRef.current.trigger.updateFileContent({
      path: context.activeFilePath,
      content,
    });
  };

  const saveProject = (): Promise<void> => {
    if (typeof window === "undefined") {
      return Promise.resolve();
    }

    const context = workspaceStoreRef.current.getSnapshot().context;
    if (!context.isInitialized) {
      return Promise.resolve();
    }

    const { activeFilePath, dirtyState, project, savedSnapshot } = context;
    const hasBinaryAssets = collectBinaryAssetPaths(project).length > 0;
    const assetGeneration = hasBinaryAssets ? createWorkspaceAssetGeneration() : undefined;
    const intentionallyChangedPaths = new Set([
      ...dirtyState.addedFilePaths,
      ...dirtyState.modifiedFilePaths,
    ]);
    const sourceAssetPaths = new Set(
      savedSnapshot.project.id === project.id
        ? Object.values(project.files)
            .filter(
              (file) =>
                file.encoding === "base64" &&
                file.content === "" &&
                !intentionallyChangedPaths.has(file.path),
            )
            .map((file) => file.path)
        : [],
    );
    // Capture an immutable store snapshot at invocation. If the user keeps editing
    // while this save is in flight, markSaved compares those newer edits against
    // this exact durable generation and correctly leaves them dirty.
    const storedSnapshot = {
      activeFilePath,
      project,
      assetGeneration,
    } satisfies StoredWorkspaceSnapshot;

    const run = async () => {
      workspaceStoreRef.current.trigger.beginSave();

      try {
        if (assetGeneration) {
          const latestContext = workspaceStoreRef.current.getSnapshot().context;
          const sourceSnapshot =
            latestContext.isInitialized && latestContext.savedSnapshot.project.id === project.id
              ? latestContext.savedSnapshot
              : undefined;
          await persistWorkspaceAssets(project, {
            generation: assetGeneration,
            sourceGeneration: sourceSnapshot?.assetGeneration,
            sourceAssetPaths,
          });
        }

        // Publish metadata only after its referenced asset generation commits.
        window.localStorage.setItem(
          WORKSPACE_STORAGE_KEY,
          JSON.stringify(toPersistedSnapshot(storedSnapshot)),
        );
        workspaceStoreRef.current.trigger.markSaved({
          snapshot: cloneWorkspaceSnapshot(storedSnapshot),
        });

        if (
          assetGeneration &&
          Object.values(project.files).some(
            (file) => file.encoding === "base64" && file.content === "",
          )
        ) {
          void loadWorkspaceAssetContents(project, assetGeneration)
            .then((contents) => {
              workspaceStoreRef.current.trigger.hydrateAssetContents({ contents });
            })
            .catch((error) => {
              console.warn("Failed to hydrate the saved workspace assets:", error);
            });
        }

        // Old generations are no longer reachable after the metadata commit.
        void pruneWorkspaceAssetGenerations(assetGeneration ?? "").catch((error) => {
          console.warn("Failed to prune old workspace assets:", error);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The workspace could not be saved";
        workspaceStoreRef.current.trigger.saveFailed({ message });
        console.warn("Failed to save workspace snapshot:", error);
      }
    };

    const result = saveQueueRef.current.then(run, run);
    saveQueueRef.current = result.catch(() => undefined);
    return result;
  };

  const loadProject = (
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
  };

  const createNewEditor = () => {
    loadProject(createStarterHtmlCssWorkspace());
  };

  const updateLessonType = (lessonType: WorkspaceLessonType) => {
    workspaceStoreRef.current.trigger.updateLessonType({ lessonType });
  };

  const reconcileExternalProject = (project: WorkspaceProject) => {
    workspaceStoreRef.current.trigger.reconcileExternalProject({
      project: normalizeProject(project),
    });
  };

  const getProject = () => {
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
  };

  const getWorkspaceRevision = () => {
    return workspaceStoreRef.current.getSnapshot().context.syncVersion;
  };

  const getActiveFilePath = () => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    return context.isInitialized ? context.activeFilePath : "";
  };

  const getCollapsedFolders = () => {
    return workspaceStoreRef.current.getSnapshot().context.collapsedFolders;
  };

  const getSidebarScrollTop = () => {
    return workspaceStoreRef.current.getSnapshot().context.sidebarScrollTop;
  };

  const getSidebarWidth = () => {
    return workspaceStoreRef.current.getSnapshot().context.sidebarWidth;
  };

  const getFile = (path: string) => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    if (!context.isInitialized) {
      return null;
    }
    return context.project.files[normalizeWorkspacePath(path)] ?? null;
  };

  const listFiles = () => {
    const context = workspaceStoreRef.current.getSnapshot().context;
    return context.isInitialized
      ? Object.values(context.project.files).sort((left, right) =>
          left.path.localeCompare(right.path),
        )
      : [];
  };

  const subscribeWorkspaceSync = (
    listener: (mutation: WorkspaceSyncMutation) => void,
  ): (() => void) => {
    const store = workspaceStoreRef.current;
    let observedRevision = store.getSnapshot().context.syncVersion;
    const subscription = store.subscribe((snapshot) => {
      const context = snapshot.context;
      if (!context.isInitialized || context.syncVersion === observedRevision) return;
      observedRevision = context.syncVersion;

      if (context.lastFileSync?.revision === context.syncVersion) {
        const file = context.project.files[context.lastFileSync.path];
        if (file) {
          listener({ kind: "file", revision: context.syncVersion, file });
          return;
        }
      }

      listener({ kind: "project", revision: context.syncVersion, project: context.project });
    });
    return () => subscription.unsubscribe();
  };

  const actionsValue: WorkspaceActions = {
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
    applyFileTextEdits,
    updateActiveFileContent,
    hydrateAssetContents,
    saveProject,
    loadProject,
    reconcileExternalProject,
    updateLessonType,
    getProject,
    getWorkspaceRevision,
    getActiveFilePath,
    getCollapsedFolders,
    getSidebarScrollTop,
    getSidebarWidth,
    getFile,
    listFiles,
    subscribeWorkspaceSync,
  };

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceStoreContext value={workspaceStoreRef.current}>{children}</WorkspaceStoreContext>
    </WorkspaceActionsContext>
  );
};

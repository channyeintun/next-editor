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
  migrateLegacyWorkspaceAssets,
  persistWorkspaceAssets,
  pruneWorkspaceAssets,
} from "../storage/workspaceAssetStore";
import {
  isLegacyWorkspaceBinaryFile,
  isWorkspaceTextFile,
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import { prepareTextEditEvent, type TextEditEvent } from "../types/textEdit";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import { writeStoredFileSidebarCollapsed } from "../utils/sidebarLayout";

interface WorkspaceProviderProps {
  children: React.ReactNode;
  /** Recording this surface is about to load, when it comes from a prop instead
   *  of `?url=` — see createInitialWorkspaceSnapshot. Start empty rather than
   *  from the persisted workspace, which the recording would only overwrite. */
  pendingRecordingUrl?: string;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
  pendingRecordingUrl,
}) => {
  const initialSnapshotRef = useRef<StoredWorkspaceSnapshot | null>(
    createInitialWorkspaceSnapshot(pendingRecordingUrl),
  );
  const workspaceStoreRef = useRef(createWorkspaceStore(initialSnapshotRef.current));
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Convert v1 generation/path binary entries to content-addressed descriptors.
  // The bytes remain in IndexedDB and are loaded only by a concrete consumer.
  useEffect(() => {
    let cancelled = false;
    const store = workspaceStoreRef.current;
    const context = store.getSnapshot().context;

    if (!context.isInitialized) {
      return;
    }

    void migrateLegacyWorkspaceAssets(context.project, context.savedSnapshot.assetGeneration)
      .then((descriptors) => {
        if (cancelled || Object.keys(descriptors).length === 0) {
          return;
        }

        store.trigger.hydrateAssetDescriptors({ descriptors });
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

  const createFile = (
    path: string,
    content: WorkspaceFileContent = "",
    encoding?: WorkspaceFileEncoding,
  ) => {
    workspaceStoreRef.current.trigger.createFile({ path, content, encoding });
  };

  const createFolder = (path: string) => {
    workspaceStoreRef.current.trigger.createFolder({ path });
  };

  const hydrateAssetDescriptors: WorkspaceActions["hydrateAssetDescriptors"] = (descriptors) => {
    workspaceStoreRef.current.trigger.hydrateAssetDescriptors({ descriptors });
  };

  const notifyAssetAvailable = (assetId: string) => {
    workspaceStoreRef.current.trigger.notifyAssetAvailable({ assetId });
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
    if (!file || !isWorkspaceTextFile(file) || !prepareTextEditEvent(event, file.content.length)) {
      return null;
    }

    workspaceStoreRef.current.trigger.applyFileTextEdits({ ...event, path });
    const nextContext = workspaceStoreRef.current.getSnapshot().context;
    if (!nextContext.isInitialized) return null;
    const nextFile = nextContext.project.files[path];
    return nextFile && isWorkspaceTextFile(nextFile) ? nextFile.content : null;
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

    const { activeFilePath, project, savedSnapshot } = context;

    const run = async () => {
      workspaceStoreRef.current.trigger.beginSave();

      try {
        const migratedDescriptors = await migrateLegacyWorkspaceAssets(
          project,
          savedSnapshot.assetGeneration,
        );
        const storedProject: WorkspaceProject =
          Object.keys(migratedDescriptors).length === 0
            ? project
            : {
                ...project,
                files: Object.fromEntries(
                  Object.entries(project.files).map(([path, file]): [string, WorkspaceFile] => {
                    const descriptor = migratedDescriptors[path];
                    return descriptor && isLegacyWorkspaceBinaryFile(file)
                      ? [path, { ...file, content: descriptor, encoding: "asset" as const }]
                      : [path, file];
                  }),
                ),
              };
        if (Object.keys(migratedDescriptors).length > 0) {
          workspaceStoreRef.current.trigger.hydrateAssetDescriptors({
            descriptors: migratedDescriptors,
          });
        }
        await persistWorkspaceAssets(storedProject);

        // Capture the exact durable project generation. Edits arriving while
        // this save is in flight remain dirty against this snapshot.
        const storedSnapshot = {
          activeFilePath,
          project: storedProject,
        } satisfies StoredWorkspaceSnapshot;

        // Publish metadata only after every referenced asset is durable.
        window.localStorage.setItem(
          WORKSPACE_STORAGE_KEY,
          JSON.stringify(toPersistedSnapshot(storedSnapshot)),
        );
        workspaceStoreRef.current.trigger.markSaved({
          snapshot: cloneWorkspaceSnapshot(storedSnapshot),
        });

        void pruneWorkspaceAssets(storedProject).catch((error) => {
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
    hydrateAssetDescriptors,
    notifyAssetAvailable,
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

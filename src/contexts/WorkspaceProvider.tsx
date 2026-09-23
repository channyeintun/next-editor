import { useEffect, useRef, useState } from "react";
import {
  WorkspaceActionsContext,
  type WorkspaceActions,
  type WorkspaceSyncMutation,
} from "./WorkspaceContext";
import {
  WORKSPACE_STORAGE_KEY,
  WorkspaceStoreContext,
  createInitialWorkspaceSnapshot,
  createWorkspaceStore,
  normalizeProject,
  toPersistedSnapshot,
  type InitializedWorkspaceState,
  type StoredWorkspaceSnapshot,
  type WorkspaceStoreInstance,
} from "../stores/workspaceStore";
import {
  migrateLegacyWorkspaceAssets,
  persistWorkspaceAssets,
  pruneLegacyWorkspaceAssetKeys,
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
import { writeStoredFileSidebarCollapsed } from "../utils/sidebarLayout";

interface WorkspaceProviderProps {
  children: React.ReactNode;
  /** Recording this surface is about to load, when it comes from a prop instead
   *  of `?url=` — see createInitialWorkspaceSnapshot. Start empty rather than
   *  from the persisted workspace, which the recording would only overwrite. */
  pendingRecordingUrl?: string;
}

/**
 * Makes one workspace generation durable: the assets first, then the
 * localStorage metadata that references them. A failure leaves the workspace
 * dirty and is reported through the store. Module-level so WorkspaceProvider
 * stays compilable: the React Compiler skips a component whose try/catch holds
 * conditional expressions.
 */
async function persistWorkspace(
  workspaceStore: WorkspaceStoreInstance,
  { activeFilePath, project, savedSnapshot, workspaceLoadVersion }: InitializedWorkspaceState,
): Promise<void> {
  workspaceStore.trigger.beginSave({ workspaceLoadVersion });

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
      workspaceStore.trigger.hydrateAssetDescriptors({ descriptors: migratedDescriptors });
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
    workspaceStore.trigger.markSaved({
      snapshot: storedSnapshot,
      workspaceLoadVersion,
    });

    void pruneLegacyWorkspaceAssetKeys().catch((error) => {
      console.warn("Failed to prune old workspace assets:", error);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The workspace could not be saved";
    workspaceStore.trigger.saveFailed({ message, workspaceLoadVersion });
    console.warn("Failed to save workspace snapshot:", error);
  }
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
  pendingRecordingUrl,
}) => {
  // Created once: the initial snapshot parses the whole saved workspace.
  const [workspaceStore] = useState(() =>
    createWorkspaceStore(createInitialWorkspaceSnapshot(pendingRecordingUrl)),
  );
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Convert v1 generation/path binary entries to content-addressed descriptors.
  // The bytes remain in IndexedDB and are loaded only by a concrete consumer.
  useEffect(() => {
    let cancelled = false;
    const context = workspaceStore.getSnapshot().context;

    if (!context.isInitialized) {
      return;
    }

    void migrateLegacyWorkspaceAssets(context.project, context.savedSnapshot.assetGeneration)
      .then((descriptors) => {
        if (cancelled || Object.keys(descriptors).length === 0) {
          return;
        }

        workspaceStore.trigger.hydrateAssetDescriptors({ descriptors });
      })
      .catch((error) => {
        if (!cancelled) {
          workspaceStore.trigger.saveFailed({
            message:
              error instanceof Error
                ? error.message
                : "The saved binary workspace assets could not be loaded",
            workspaceLoadVersion: context.workspaceLoadVersion,
          });
        }
        console.warn("Failed to load workspace assets:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceStore]);

  const setActiveFilePath = (path: string) => {
    workspaceStore.trigger.setActiveFilePath({ path });
  };

  const setPreviewFilePath = (path: string) => {
    workspaceStore.trigger.setPreviewFilePath({ path });
  };

  const setCollapsedFolders = (paths: string[]) => {
    workspaceStore.trigger.setCollapsedFolders({ paths });
  };

  const setSidebarScrollTop = (scrollTop: number) => {
    workspaceStore.trigger.setSidebarScrollTop({ scrollTop });
  };

  const setSidebarWidth = (width: number) => {
    // Width is session-only: not written to storage, so it resets to the default
    // on reload. Recording captures resizes as offsets via handleWorkspaceEvent.
    workspaceStore.trigger.setSidebarWidth({ width });
  };

  const setSidebarCollapsed = (collapsed: boolean) => {
    workspaceStore.trigger.setSidebarCollapsed({ collapsed });
    writeStoredFileSidebarCollapsed(workspaceStore.getSnapshot().context.sidebarCollapsed);
  };

  // The same trigger with no write behind it: a lesson that opens with the
  // explorer shut must not leave that behind in the viewer's own editor.
  const startSidebarCollapsed = (collapsed: boolean) => {
    workspaceStore.trigger.setSidebarCollapsed({ collapsed });
  };

  const createFile = (
    path: string,
    content: WorkspaceFileContent = "",
    encoding?: WorkspaceFileEncoding,
  ) => {
    workspaceStore.trigger.createFile({ path, content, encoding });
  };

  const createFolder = (path: string) => {
    workspaceStore.trigger.createFolder({ path });
  };

  const notifyAssetAvailable = (assetId: string) => {
    workspaceStore.trigger.notifyAssetAvailable({ assetId });
  };

  const renameFile = (currentPath: string, nextPath: string) => {
    workspaceStore.trigger.renameFile({
      currentPath,
      nextPath,
    });
  };

  const renameFolder = (currentPath: string, nextPath: string) => {
    workspaceStore.trigger.renameFolder({
      currentPath,
      nextPath,
    });
  };

  const deleteFile = (path: string) => {
    workspaceStore.trigger.deleteFile({ path });
  };

  const deleteFolder = (path: string) => {
    workspaceStore.trigger.deleteFolder({ path });
  };

  const updateFileContent = (path: string, content: string) => {
    workspaceStore.trigger.updateFileContent({
      path,
      content,
    });
  };

  const applyFileTextEdits = (event: TextEditEvent): string | null => {
    const context = workspaceStore.getSnapshot().context;
    if (!context.isInitialized) return null;

    const path = normalizeWorkspacePath(event.path);
    const file = context.project.files[path];
    if (!file || !isWorkspaceTextFile(file) || !prepareTextEditEvent(event, file.content.length)) {
      return null;
    }

    workspaceStore.trigger.applyFileTextEdits({ ...event, path });
    const nextContext = workspaceStore.getSnapshot().context;
    if (!nextContext.isInitialized) return null;
    const nextFile = nextContext.project.files[path];
    return nextFile && isWorkspaceTextFile(nextFile) ? nextFile.content : null;
  };

  const saveProject = (): Promise<void> => {
    if (typeof window === "undefined") {
      return Promise.resolve();
    }

    const context = workspaceStore.getSnapshot().context;
    if (!context.isInitialized) {
      return Promise.resolve();
    }

    const run = () => persistWorkspace(workspaceStore, context);

    const result = saveQueueRef.current.then(run, run);
    saveQueueRef.current = result.catch(() => undefined);
    return result;
  };

  const loadProject = (
    project: WorkspaceProject,
    nextActiveFilePath?: string,
    collapsedFolders?: string[],
    sidebarScrollTop?: number,
  ) => {
    const normalizedProject = normalizeProject(project);
    const normalizedNextActiveFilePath = normalizeWorkspacePath(nextActiveFilePath ?? "");
    const resolvedActiveFilePath = normalizedProject.files[normalizedNextActiveFilePath]
      ? normalizedNextActiveFilePath
      : normalizedProject.entryFilePath;

    const savedSnapshot: StoredWorkspaceSnapshot = {
      activeFilePath: resolvedActiveFilePath,
      project: normalizedProject,
    };

    workspaceStore.trigger.loadProject({
      project: normalizedProject,
      activeFilePath: resolvedActiveFilePath,
      collapsedFolders,
      sidebarScrollTop,
      savedSnapshot,
    });
  };

  const updateLessonType = (lessonType: WorkspaceLessonType) => {
    workspaceStore.trigger.updateLessonType({ lessonType });
  };

  const reconcileExternalProject = (project: WorkspaceProject) => {
    // The transition normalizes the project (the agent's bash tool triggers it directly).
    workspaceStore.trigger.reconcileExternalProject({ project });
  };

  const getProject = () => {
    const context = workspaceStore.getSnapshot().context;
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
    return workspaceStore.getSnapshot().context.syncVersion;
  };

  const getActiveFilePath = () => {
    const context = workspaceStore.getSnapshot().context;
    return context.isInitialized ? context.activeFilePath : "";
  };

  const getCollapsedFolders = () => {
    return workspaceStore.getSnapshot().context.collapsedFolders;
  };

  const getSidebarScrollTop = () => {
    return workspaceStore.getSnapshot().context.sidebarScrollTop;
  };

  const getSidebarWidth = () => {
    return workspaceStore.getSnapshot().context.sidebarWidth;
  };

  const getSidebarCollapsed = () => {
    return workspaceStore.getSnapshot().context.sidebarCollapsed;
  };

  const getFile = (path: string) => {
    const context = workspaceStore.getSnapshot().context;
    if (!context.isInitialized) {
      return null;
    }
    return context.project.files[normalizeWorkspacePath(path)] ?? null;
  };

  const subscribeWorkspaceSync = (
    listener: (mutation: WorkspaceSyncMutation) => void,
  ): (() => void) => {
    let observedRevision = workspaceStore.getSnapshot().context.syncVersion;
    const subscription = workspaceStore.subscribe((snapshot) => {
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
    startSidebarCollapsed,
    createFile,
    createFolder,
    deleteFolder,
    renameFile,
    renameFolder,
    deleteFile,
    updateFileContent,
    applyFileTextEdits,
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
    getSidebarCollapsed,
    getFile,
    subscribeWorkspaceSync,
  };

  return (
    <WorkspaceActionsContext value={actionsValue}>
      <WorkspaceStoreContext value={workspaceStore}>{children}</WorkspaceStoreContext>
    </WorkspaceActionsContext>
  );
};

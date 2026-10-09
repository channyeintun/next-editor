import {
  WORKSPACE_STORAGE_KEY,
  normalizeProject,
  toPersistedSnapshot,
  type InitializedWorkspaceState,
  type StoredWorkspaceSnapshot,
  type WorkspaceStoreInstance,
} from "./workspaceStore";
import { resolveActiveFilePath, withMigratedAssetDescriptors } from "./workspaceProjectSupport";
import {
  migrateLegacyWorkspaceAssets,
  persistWorkspaceAssets,
  pruneLegacyWorkspaceAssetKeys,
} from "../storage/workspaceAssetStore";
import {
  isWorkspaceTextFile,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import { normalizeWorkspacePath } from "../types/workspacePaths";
import { prepareTextEditEvent, type TextEditEvent } from "../types/textEdit";
import { writeStoredFileSidebarCollapsed } from "../utils/sidebarLayout";

/**
 * Makes one workspace generation durable: the assets first, then the
 * localStorage metadata that references them. A failure leaves the workspace
 * dirty and is reported through the store.
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
    const storedFiles = withMigratedAssetDescriptors(project.files, migratedDescriptors);
    const storedProject: WorkspaceProject =
      storedFiles === project.files ? project : { ...project, files: storedFiles };
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

export interface WorkspaceActions {
  setActiveFilePath: (path: string) => void;
  setPreviewFilePath: (path: string) => void;
  setCollapsedFolders: (paths: string[]) => void;
  setSidebarScrollTop: (scrollTop: number) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /**
   * Where a replay starts the file explorer, without touching what the viewer
   * has stored. Their own preference is still there the next time they open
   * the editor themselves; a lesson only gets to choose its opening frame.
   */
  startSidebarCollapsed: (collapsed: boolean) => void;
  createFile: (
    path: string,
    content?: WorkspaceFileContent,
    encoding?: WorkspaceFileEncoding,
  ) => void;
  createFolder: (path: string) => void;
  renameFile: (currentPath: string, nextPath: string) => void;
  renameFolder: (currentPath: string, nextPath: string) => void;
  deleteFile: (path: string) => void;
  deleteFolder: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  applyFileTextEdits: (event: TextEditEvent) => string | null;
  notifyAssetAvailable: (assetId: string) => void;
  saveProject: () => Promise<void>;
  loadProject: (
    project: WorkspaceProject,
    activeFilePath?: string,
    collapsedFolders?: string[],
    sidebarScrollTop?: number,
  ) => void;
  reconcileExternalProject: (project: WorkspaceProject) => void;
  updateLessonType: (lessonType: WorkspaceLessonType) => void;
  getProject: () => WorkspaceProject;
  getWorkspaceRevision: () => number;
  getActiveFilePath: () => string;
  getCollapsedFolders: () => string[];
  getSidebarScrollTop: () => number;
  getSidebarWidth: () => number;
  getSidebarCollapsed: () => boolean;
  getFile: (path: string) => WorkspaceFile | null;
  subscribeWorkspaceSync: (listener: (mutation: WorkspaceSyncMutation) => void) => () => void;
}

export type WorkspaceSyncMutation =
  | { kind: "file"; revision: number; file: WorkspaceFile }
  | { kind: "project"; revision: number; project: WorkspaceProject };

/**
 * The imperative workspace API over one store, as WorkspaceActionsContext
 * hands it out. WorkspaceProvider builds it once, next to the store, so every
 * action is stable by construction rather than by the React Compiler's
 * memoization, and the save queue is plain closure state instead of a ref.
 * It also keeps persistWorkspace out of the component: the compiler skips a
 * component whose try/catch holds conditional expressions.
 *
 * `persist: false` turns saveProject into a no-op, for a surface whose
 * workspace is not the user's project (the /studio render page): every tab
 * shares one saved workspace, so saving there would overwrite it.
 */
export function createWorkspaceActions(
  workspaceStore: WorkspaceStoreInstance,
  { persist = true }: { persist?: boolean } = {},
): WorkspaceActions {
  // Saves run one at a time, in call order; each persists the project as it
  // was when it was called.
  let saveQueue: Promise<void> = Promise.resolve();

  return {
    setActiveFilePath: (path) => {
      workspaceStore.trigger.setActiveFilePath({ path });
    },

    setPreviewFilePath: (path) => {
      workspaceStore.trigger.setPreviewFilePath({ path });
    },

    setCollapsedFolders: (paths) => {
      workspaceStore.trigger.setCollapsedFolders({ paths });
    },

    setSidebarScrollTop: (scrollTop) => {
      workspaceStore.trigger.setSidebarScrollTop({ scrollTop });
    },

    setSidebarWidth: (width) => {
      // Width is session-only: not written to storage, so it resets to the default
      // on reload. Recording captures resizes as offsets via handleWorkspaceEvent.
      workspaceStore.trigger.setSidebarWidth({ width });
    },

    setSidebarCollapsed: (collapsed) => {
      workspaceStore.trigger.setSidebarCollapsed({ collapsed });
      writeStoredFileSidebarCollapsed(collapsed);
    },

    // The same trigger with no write behind it: a lesson that opens with the
    // explorer shut must not leave that behind in the viewer's own editor.
    startSidebarCollapsed: (collapsed) => {
      workspaceStore.trigger.setSidebarCollapsed({ collapsed });
    },

    createFile: (path, content = "", encoding) => {
      workspaceStore.trigger.createFile({ path, content, encoding });
    },

    createFolder: (path) => {
      workspaceStore.trigger.createFolder({ path });
    },

    deleteFolder: (path) => {
      workspaceStore.trigger.deleteFolder({ path });
    },

    renameFile: (currentPath, nextPath) => {
      workspaceStore.trigger.renameFile({
        currentPath,
        nextPath,
      });
    },

    renameFolder: (currentPath, nextPath) => {
      workspaceStore.trigger.renameFolder({
        currentPath,
        nextPath,
      });
    },

    deleteFile: (path) => {
      workspaceStore.trigger.deleteFile({ path });
    },

    updateFileContent: (path, content) => {
      workspaceStore.trigger.updateFileContent({
        path,
        content,
      });
    },

    applyFileTextEdits: (event) => {
      const context = workspaceStore.getSnapshot().context;
      if (!context.isInitialized) return null;

      const path = normalizeWorkspacePath(event.path);
      const file = context.project.files[path];
      if (
        !file ||
        !isWorkspaceTextFile(file) ||
        !prepareTextEditEvent(event, file.content.length)
      ) {
        return null;
      }

      workspaceStore.trigger.applyFileTextEdits({ ...event, path });
      const nextContext = workspaceStore.getSnapshot().context;
      if (!nextContext.isInitialized) return null;
      const nextFile = nextContext.project.files[path];
      return nextFile && isWorkspaceTextFile(nextFile) ? nextFile.content : null;
    },

    notifyAssetAvailable: (assetId) => {
      workspaceStore.trigger.notifyAssetAvailable({ assetId });
    },

    saveProject: () => {
      if (!persist || typeof window === "undefined") {
        return Promise.resolve();
      }

      const context = workspaceStore.getSnapshot().context;
      if (!context.isInitialized) {
        return Promise.resolve();
      }

      const run = () => persistWorkspace(workspaceStore, context);

      const result = saveQueue.then(run, run);
      saveQueue = result.catch(() => undefined);
      return result;
    },

    loadProject: (project, nextActiveFilePath, collapsedFolders, sidebarScrollTop) => {
      const normalizedProject = normalizeProject(project);
      const resolvedActiveFilePath = resolveActiveFilePath(
        normalizedProject,
        normalizeWorkspacePath(nextActiveFilePath ?? ""),
      );

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
    },

    reconcileExternalProject: (project) => {
      // The transition normalizes the project (the agent's bash tool triggers it directly).
      workspaceStore.trigger.reconcileExternalProject({ project });
    },

    updateLessonType: (lessonType) => {
      workspaceStore.trigger.updateLessonType({ lessonType });
    },

    getProject: () => {
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
    },

    getWorkspaceRevision: () => {
      return workspaceStore.getSnapshot().context.syncVersion;
    },

    getActiveFilePath: () => {
      const context = workspaceStore.getSnapshot().context;
      return context.isInitialized ? context.activeFilePath : "";
    },

    getCollapsedFolders: () => {
      return workspaceStore.getSnapshot().context.collapsedFolders;
    },

    getSidebarScrollTop: () => {
      return workspaceStore.getSnapshot().context.sidebarScrollTop;
    },

    getSidebarWidth: () => {
      return workspaceStore.getSnapshot().context.sidebarWidth;
    },

    getSidebarCollapsed: () => {
      return workspaceStore.getSnapshot().context.sidebarCollapsed;
    },

    getFile: (path) => {
      const context = workspaceStore.getSnapshot().context;
      if (!context.isInitialized) {
        return null;
      }
      return context.project.files[normalizeWorkspacePath(path)] ?? null;
    },

    subscribeWorkspaceSync: (listener) => {
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
    },
  };
}

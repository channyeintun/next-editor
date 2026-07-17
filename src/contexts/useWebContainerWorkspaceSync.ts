import { useLayoutEffect, useRef } from "react";
import type { IFSWatcher, WebContainer } from "@webcontainer/api";
import {
  createWorkspaceTree,
  getWorkspaceRuntimeFileContents,
  runSerializedWebContainerTask,
  shouldIgnoreRuntimeImportPath,
  syncWorkspaceProject,
} from "./webContainerRuntimeSupport";
import {
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";
import { incrementPerformanceCounter, startPerformanceSpan } from "../utils/performanceMetrics";

// How long a forward-sync write suppresses watch events for its path. The
// container delivers watch events for our own writes within milliseconds; the
// window only absorbs scheduling jitter. A container-side write to the same
// path inside the window is missed here but still converges through the
// server-ready / Enter-key reverse-sync triggers, and suppression is purely an
// optimization — a spurious reverse sync no-ops on the project-equality check.
const FORWARD_SYNC_ECHO_WINDOW_MS = 1000;
export const WEBCONTAINER_FILE_SYNC_WINDOW_MS = 75;

const watchFilenameDecoder = new TextDecoder();

interface EnsureProjectMountedOptions {
  instance: WebContainer;
  project: WorkspaceProject;
  onMountStart?: () => void;
}

interface QueueProjectSyncOptions {
  instance: WebContainer;
  project: WorkspaceProject;
}

interface QueueFileSyncOptions {
  instance: WebContainer;
  file: WorkspaceFile;
}

interface FlushWorkspaceSyncOptions {
  instance: WebContainer;
}

interface FileSyncWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SerializedRuntimeTaskOptions<T> {
  instance: WebContainer;
  task: () => Promise<T>;
}

interface WorkspaceSyncOptions {
  // Fired when a container process (not our own forward sync) creates, changes,
  // or removes a path the editor cares about, so the caller can schedule a
  // reverse sync without waiting for a terminal-output heuristic.
  onExternalFileChange?: (instance: WebContainer) => void;
}

export function useWebContainerWorkspaceSync({ onExternalFileChange }: WorkspaceSyncOptions = {}) {
  const hasMountedProjectRef = useRef(false);
  const mountedInstanceRef = useRef<WebContainer | null>(null);
  const lastSyncedProjectRef = useRef<WorkspaceProject | null>(null);
  const queuedProjectRef = useRef<WorkspaceProject | null>(null);
  const queuedFilesRef = useRef<Map<string, WorkspaceFile>>(new Map());
  const fileSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileSyncWaitersRef = useRef<FileSyncWaiter[]>([]);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const syncGenerationRef = useRef(0);
  const fsWatcherRef = useRef<IFSWatcher | null>(null);
  const forwardSyncWritesRef = useRef<Map<string, number>>(new Map());
  const onExternalFileChangeRef = useRef(onExternalFileChange);

  const cloneProjectForSync = (project: WorkspaceProject): WorkspaceProject => ({
    ...project,
    folders: [...project.folders],
    files: { ...project.files },
  });

  // Synced via a layout effect (not during render) so the React Compiler can
  // memoize callers; the only reader is the async fs.watch listener.
  useLayoutEffect(() => {
    onExternalFileChangeRef.current = onExternalFileChange;
  });

  const recordForwardSyncWrite = (path: string) => {
    const normalizedPath = normalizeWorkspacePath(path);

    if (normalizedPath) {
      forwardSyncWritesRef.current.set(normalizedPath, Date.now());
    }
  };

  // A watch event echoes a forward-sync write when its path — or an ancestor,
  // for children of a folder we removed recursively — was mutated inside the
  // echo window. Expired entries are pruned as they are encountered.
  const isForwardSyncEcho = (normalizedPath: string) => {
    const writes = forwardSyncWritesRef.current;
    const now = Date.now();
    const segments = normalizedPath.split("/");

    for (let length = segments.length; length > 0; length -= 1) {
      const candidate = segments.slice(0, length).join("/");
      const writtenAt = writes.get(candidate);

      if (writtenAt === undefined) {
        continue;
      }

      if (now - writtenAt <= FORWARD_SYNC_ECHO_WINDOW_MS) {
        return true;
      }

      writes.delete(candidate);
    }

    return false;
  };

  const stopFsWatch = () => {
    const watcher = fsWatcherRef.current;
    fsWatcherRef.current = null;

    try {
      watcher?.close();
    } catch {
      // The container may already be torn down; there is nothing left to close.
    }
  };

  const startFsWatch = (instance: WebContainer) => {
    stopFsWatch();

    const generation = syncGenerationRef.current;

    try {
      fsWatcherRef.current = instance.fs.watch(".", { recursive: true }, (_event, filename) => {
        if (syncGenerationRef.current !== generation) {
          return;
        }

        const rawPath =
          typeof filename === "string" ? filename : watchFilenameDecoder.decode(filename);
        const normalizedPath = normalizeWorkspacePath(rawPath);

        if (!normalizedPath || shouldIgnoreRuntimeImportPath(normalizedPath)) {
          return;
        }

        if (isForwardSyncEcho(normalizedPath)) {
          return;
        }

        onExternalFileChangeRef.current?.(instance);
      });
    } catch {
      // fs.watch is unavailable on this container build; callers fall back to
      // the terminal-output reverse-sync heuristic (see isFsWatchActive).
      fsWatcherRef.current = null;
    }
  };

  const isFsWatchActive = () => fsWatcherRef.current !== null;

  const enqueueSyncTask = (task: () => Promise<void>): Promise<void> => {
    const result = syncQueueRef.current.then(task, task);
    syncQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const ensureProjectMounted = async ({
    instance,
    project,
    onMountStart,
  }: EnsureProjectMountedOptions) => {
    if (hasMountedProjectRef.current && mountedInstanceRef.current === instance) {
      return;
    }

    const generation = syncGenerationRef.current;

    onMountStart?.();
    const endMountSpan = startPerformanceSpan("webcontainer.initial_mount");
    let mountOutcome = "success";
    try {
      await runSerializedWebContainerTask(instance, async () =>
        instance.mount(await createWorkspaceTree(project)),
      );
    } catch (error) {
      mountOutcome = "failure";
      throw error;
    } finally {
      endMountSpan({ outcome: mountOutcome });
    }

    if (syncGenerationRef.current !== generation) {
      return;
    }

    mountedInstanceRef.current = instance;
    lastSyncedProjectRef.current = cloneProjectForSync(project);
    queuedProjectRef.current = null;
    hasMountedProjectRef.current = true;

    // Started only after the mount finishes so the initial tree never echoes
    // back as external changes.
    startFsWatch(instance);
  };

  const flushQueuedFiles = ({ instance }: FlushWorkspaceSyncOptions): Promise<void> => {
    if (fileSyncTimerRef.current !== null) {
      clearTimeout(fileSyncTimerRef.current);
      fileSyncTimerRef.current = null;
    }

    const files = Array.from(queuedFilesRef.current.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    if (files.length === 0) return syncQueueRef.current;
    queuedFilesRef.current.clear();
    const waiters = fileSyncWaitersRef.current;
    fileSyncWaitersRef.current = [];
    const generation = syncGenerationRef.current;

    const result = enqueueSyncTask(async () => {
      if (
        syncGenerationRef.current !== generation ||
        mountedInstanceRef.current !== instance ||
        !hasMountedProjectRef.current
      ) {
        return;
      }

      const endSyncSpan = startPerformanceSpan("webcontainer.file_sync", {
        path_count: files.length,
      });
      let mutationCount = 0;
      let syncOutcome = "success";
      try {
        await runSerializedWebContainerTask(instance, async () => {
          for (const file of files) {
            recordForwardSyncWrite(file.path);
            await instance.fs.writeFile(file.path, await getWorkspaceRuntimeFileContents(file));
            mutationCount += 1;
          }
        });
      } catch (error) {
        syncOutcome = "failure";
        throw error;
      } finally {
        endSyncSpan({ outcome: syncOutcome });
        incrementPerformanceCounter("webcontainer.fs_mutations", mutationCount, {
          outcome: syncOutcome,
          source: "file_queue",
        });
      }

      if (syncGenerationRef.current !== generation) return;
      const lastSyncedProject = lastSyncedProjectRef.current;
      if (lastSyncedProject) {
        for (const file of files) lastSyncedProject.files[file.path] = file;
      }
    });

    void result.then(
      () => {
        for (const waiter of waiters) waiter.resolve();
      },
      (error: unknown) => {
        for (const waiter of waiters) waiter.reject(error);
      },
    );
    return result;
  };

  const queueFileSync = ({ instance, file }: QueueFileSyncOptions): Promise<void> => {
    if (!hasMountedProjectRef.current || mountedInstanceRef.current !== instance) {
      return Promise.resolve();
    }

    const path = normalizeWorkspacePath(file.path);
    if (!path) return Promise.resolve();
    queuedFilesRef.current.set(path, path === file.path ? file : { ...file, path });

    const result = new Promise<void>((resolve, reject) => {
      fileSyncWaitersRef.current.push({ resolve, reject });
    });
    if (fileSyncTimerRef.current === null) {
      fileSyncTimerRef.current = setTimeout(() => {
        fileSyncTimerRef.current = null;
        void flushQueuedFiles({ instance }).catch(() => undefined);
      }, WEBCONTAINER_FILE_SYNC_WINDOW_MS);
    }
    return result;
  };

  const queueProjectSync = ({ instance, project }: QueueProjectSyncOptions) => {
    if (!hasMountedProjectRef.current || mountedInstanceRef.current !== instance) {
      return Promise.resolve();
    }

    const generation = syncGenerationRef.current;
    if (fileSyncTimerRef.current !== null) {
      clearTimeout(fileSyncTimerRef.current);
      fileSyncTimerRef.current = null;
    }
    queuedFilesRef.current.clear();
    const supersededFileWaiters = fileSyncWaitersRef.current;
    fileSyncWaitersRef.current = [];
    queuedProjectRef.current = project;

    const runQueuedSync = async () => {
      while (queuedProjectRef.current && syncGenerationRef.current === generation) {
        const nextProject = queuedProjectRef.current;
        queuedProjectRef.current = null;

        if (
          !nextProject ||
          mountedInstanceRef.current !== instance ||
          syncGenerationRef.current !== generation
        ) {
          continue;
        }

        const endSyncSpan = startPerformanceSpan("webcontainer.project_sync");
        let mutationCount = 0;
        let syncOutcome = "success";
        try {
          await runSerializedWebContainerTask(instance, () =>
            syncWorkspaceProject(instance, lastSyncedProjectRef.current, nextProject, (path) => {
              mutationCount += 1;
              recordForwardSyncWrite(path);
            }),
          );
        } catch (error) {
          syncOutcome = "failure";
          throw error;
        } finally {
          endSyncSpan({ outcome: syncOutcome });
          incrementPerformanceCounter("webcontainer.fs_mutations", mutationCount, {
            outcome: syncOutcome,
          });
        }

        if (syncGenerationRef.current !== generation) {
          return;
        }

        lastSyncedProjectRef.current = cloneProjectForSync(nextProject);
      }
    };

    const result = enqueueSyncTask(runQueuedSync);
    void result.then(
      () => {
        for (const waiter of supersededFileWaiters) waiter.resolve();
      },
      (error: unknown) => {
        for (const waiter of supersededFileWaiters) waiter.reject(error);
      },
    );
    return result;
  };

  const flushWorkspaceSync = async ({ instance }: FlushWorkspaceSyncOptions): Promise<void> => {
    await flushQueuedFiles({ instance });
    await syncQueueRef.current;
  };

  /**
   * Run a runtime filesystem read on the same queue as forward writes. Resetting
   * the workspace invalidates both queued and in-flight results.
   */
  const runSerializedRuntimeTask = <T>({
    instance,
    task,
  }: SerializedRuntimeTaskOptions<T>): Promise<T | undefined> => {
    const generation = syncGenerationRef.current;

    const run = async (): Promise<T | undefined> => {
      if (
        syncGenerationRef.current !== generation ||
        mountedInstanceRef.current !== instance ||
        !hasMountedProjectRef.current
      ) {
        return undefined;
      }

      const result = await runSerializedWebContainerTask(instance, task);

      return syncGenerationRef.current === generation && mountedInstanceRef.current === instance
        ? result
        : undefined;
    };

    const result = syncQueueRef.current.then(run, run);
    syncQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const resetWorkspaceSync = () => {
    syncGenerationRef.current += 1;
    stopFsWatch();
    if (fileSyncTimerRef.current !== null) {
      clearTimeout(fileSyncTimerRef.current);
      fileSyncTimerRef.current = null;
    }
    forwardSyncWritesRef.current.clear();
    queuedFilesRef.current.clear();
    for (const waiter of fileSyncWaitersRef.current) waiter.resolve();
    fileSyncWaitersRef.current = [];
    hasMountedProjectRef.current = false;
    mountedInstanceRef.current = null;
    lastSyncedProjectRef.current = null;
    queuedProjectRef.current = null;
    syncQueueRef.current = Promise.resolve();
  };

  return {
    hasMountedProjectRef,
    ensureProjectMounted,
    flushWorkspaceSync,
    isFsWatchActive,
    queueFileSync,
    queueProjectSync,
    runSerializedRuntimeTask,
    resetWorkspaceSync,
  };
}

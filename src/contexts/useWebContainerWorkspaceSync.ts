import { useLayoutEffect, useRef } from "react";
import type { IFSWatcher, WebContainer } from "@webcontainer/api";
import {
  createWorkspaceTree,
  getWorkspaceRuntimeFileContents,
  readWorkspaceProject,
  shouldIgnoreRuntimeImportPath,
  syncWorkspaceProject,
} from "../runtime/webcontainer/files";
import { runSerializedWebContainerTask } from "../runtime/webcontainer/sharedContainer";
import type { WorkspaceActions } from "../stores/workspaceActions";
import {
  areWorkspaceProjectsEqual,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";
import { normalizeWorkspacePath } from "../types/workspacePaths";
import { incrementPerformanceCounter, startPerformanceSpan } from "../utils/performanceMetrics";

// How long a forward-sync write suppresses watch events for its path. The
// container delivers watch events for our own writes within milliseconds; the
// window only absorbs scheduling jitter. A container-side write to the same
// path inside the window is missed here but still converges through the
// server-ready / Enter-key reverse-sync triggers, and suppression is purely an
// optimization — a spurious reverse sync no-ops on the project-equality check.
const FORWARD_SYNC_ECHO_WINDOW_MS = 1000;
export const WEBCONTAINER_FILE_SYNC_WINDOW_MS = 75;
// Reverse-sync requests closer together than this coalesce into one container read.
export const WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS = 150;

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

/**
 * What the reverse sync (container to workspace) needs from its callers: the
 * workspace store it reads and reconciles into, and the runtime session's
 * generation guards. All of them are read at the asynchronous moment they are
 * used, never during render.
 */
export interface WorkspaceSyncOptions extends Pick<
  WorkspaceActions,
  "getProject" | "getWorkspaceRevision" | "reconcileExternalProject"
> {
  /** False while the lesson does not run in the container; a due reverse sync then skips. */
  shouldReverseSync: () => boolean;
  getRuntimeGeneration: () => number;
  isRuntimeGenerationActive: (generation: number) => boolean;
  /** Reports a failed reverse sync for `generation` in the runner console. */
  reportErrorFor: (generation: number) => (error: unknown) => void;
}

// The try blocks live in these module-level helpers rather than in the hook: the
// React Compiler skips a function containing a try/finally, and a hook it skips
// hands its callers new functions on every render.

type SyncOutcome = "success" | "failure";

/** Runs a sync step, reports whether it succeeded, and rethrows its failure. */
async function withSyncOutcome<T>(
  task: () => Promise<T>,
  report: (outcome: SyncOutcome) => void,
): Promise<T> {
  let outcome: SyncOutcome = "success";
  try {
    return await task();
  } catch (error) {
    outcome = "failure";
    throw error;
  } finally {
    report(outcome);
  }
}

function closeWatcher(watcher: IFSWatcher | null): void {
  try {
    watcher?.close();
  } catch {
    // The container may already be torn down; there is nothing left to close.
  }
}

/**
 * Watches the container's workdir recursively, or returns null where this
 * container build has no fs.watch; callers then fall back to the terminal-output
 * reverse-sync heuristic (see isFsWatchActive).
 */
function watchWorkdir(
  instance: WebContainer,
  onChange: (filename: string | Uint8Array) => void,
): IFSWatcher | null {
  try {
    return instance.fs.watch(".", { recursive: true }, (_event, filename) => onChange(filename));
  } catch {
    return null;
  }
}

/**
 * The copy of `project` that later syncs diff against. flushQueuedFiles updates
 * its file map in place, which must not reach the store's project.
 */
function cloneProjectForSync(project: WorkspaceProject): WorkspaceProject {
  return {
    ...project,
    folders: [...project.folders],
    files: { ...project.files },
  };
}

/** Resolves or rejects the callers waiting on queued file writes as `result` settles. */
function settleFileSyncWaiters(result: Promise<void>, waiters: FileSyncWaiter[]): void {
  void result.then(
    () => {
      for (const waiter of waiters) waiter.resolve();
    },
    (error: unknown) => {
      for (const waiter of waiters) waiter.reject(error);
    },
  );
}

/**
 * Keeps the container's filesystem and the workspace in step, both ways. The
 * forward sync mirrors store changes into the container; the reverse sync pulls
 * what container processes wrote (a lockfile, generated code) back into the
 * store, when the fs.watch below reports it or a caller asks (see
 * requestReverseSync).
 */
export function useWebContainerWorkspaceSync(options: WorkspaceSyncOptions) {
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
  const reverseSyncTimeoutRef = useRef<number | null>(null);
  const reverseSyncRequestRef = useRef(0);
  const reverseSyncEnabledRef = useRef(true);
  const optionsRef = useRef(options);

  // Synced in a layout effect, not during render, so the React Compiler can
  // compile this hook; every reader is asynchronous (the fs.watch listener and
  // the reverse-sync timer).
  useLayoutEffect(() => {
    optionsRef.current = options;
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
    closeWatcher(watcher);
  };

  const startFsWatch = (instance: WebContainer) => {
    stopFsWatch();

    const generation = syncGenerationRef.current;

    fsWatcherRef.current = watchWorkdir(instance, (filename) => {
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

      // A container process changed a file our own sync didn't write: pull the
      // container filesystem back into the workspace.
      requestReverseSync(instance, optionsRef.current.getRuntimeGeneration());
    });
  };

  const isFsWatchActive = () => fsWatcherRef.current !== null;

  const isProjectMounted = () => mountedInstanceRef.current !== null;

  /** A project is mounted, and on `instance`. */
  const isMountedOn = (instance: WebContainer) => mountedInstanceRef.current === instance;

  const clearFileSyncTimer = () => {
    if (fileSyncTimerRef.current !== null) {
      clearTimeout(fileSyncTimerRef.current);
      fileSyncTimerRef.current = null;
    }
  };

  /** Runs `task` once every task queued before it has settled, whether it failed or not. */
  const enqueueSyncTask = <T>(task: () => Promise<T>): Promise<T> => {
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
    if (isMountedOn(instance)) {
      return;
    }

    const generation = syncGenerationRef.current;

    onMountStart?.();
    const endMountSpan = startPerformanceSpan("webcontainer.initial_mount");
    await withSyncOutcome(
      () =>
        runSerializedWebContainerTask(instance, async () =>
          instance.mount(await createWorkspaceTree(project)),
        ),
      (outcome) => endMountSpan({ outcome }),
    );

    if (syncGenerationRef.current !== generation) {
      return;
    }

    mountedInstanceRef.current = instance;
    lastSyncedProjectRef.current = cloneProjectForSync(project);
    queuedProjectRef.current = null;

    // Started only after the mount finishes so the initial tree never echoes
    // back as external changes.
    startFsWatch(instance);
  };

  const flushQueuedFiles = ({ instance }: FlushWorkspaceSyncOptions): Promise<void> => {
    clearFileSyncTimer();

    const files = Array.from(queuedFilesRef.current.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    if (files.length === 0) return syncQueueRef.current;
    queuedFilesRef.current.clear();
    const waiters = fileSyncWaitersRef.current;
    fileSyncWaitersRef.current = [];
    const generation = syncGenerationRef.current;

    const result = enqueueSyncTask(async () => {
      if (syncGenerationRef.current !== generation || !isMountedOn(instance)) {
        return;
      }

      const endSyncSpan = startPerformanceSpan("webcontainer.file_sync", {
        path_count: files.length,
      });
      let mutationCount = 0;
      await withSyncOutcome(
        () =>
          runSerializedWebContainerTask(instance, async () => {
            for (const file of files) {
              recordForwardSyncWrite(file.path);
              await instance.fs.writeFile(file.path, await getWorkspaceRuntimeFileContents(file));
              mutationCount += 1;
            }
          }),
        (outcome) => {
          endSyncSpan({ outcome });
          incrementPerformanceCounter("webcontainer.fs_mutations", mutationCount, {
            outcome,
            source: "file_queue",
          });
        },
      );

      if (syncGenerationRef.current !== generation) return;
      const lastSyncedProject = lastSyncedProjectRef.current;
      if (lastSyncedProject) {
        for (const file of files) lastSyncedProject.files[file.path] = file;
      }
    });

    settleFileSyncWaiters(result, waiters);
    return result;
  };

  const queueFileSync = ({ instance, file }: QueueFileSyncOptions): Promise<void> => {
    if (!isMountedOn(instance)) {
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
    if (!isMountedOn(instance)) {
      return Promise.resolve();
    }

    const generation = syncGenerationRef.current;
    clearFileSyncTimer();
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
        await withSyncOutcome(
          () =>
            runSerializedWebContainerTask(instance, () =>
              syncWorkspaceProject(instance, lastSyncedProjectRef.current, nextProject, (path) => {
                mutationCount += 1;
                recordForwardSyncWrite(path);
              }),
            ),
          (outcome) => {
            endSyncSpan({ outcome });
            incrementPerformanceCounter("webcontainer.fs_mutations", mutationCount, { outcome });
          },
        );

        if (syncGenerationRef.current !== generation) {
          return;
        }

        lastSyncedProjectRef.current = cloneProjectForSync(nextProject);
      }
    };

    const result = enqueueSyncTask(runQueuedSync);
    settleFileSyncWaiters(result, supersededFileWaiters);
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
      if (syncGenerationRef.current !== generation || !isMountedOn(instance)) {
        return undefined;
      }

      const result = await runSerializedWebContainerTask(instance, task);

      return syncGenerationRef.current === generation && mountedInstanceRef.current === instance
        ? result
        : undefined;
    };

    return enqueueSyncTask(run);
  };

  /**
   * A reverse sync has just read `project` out of the container, so the
   * container already holds it. Forward syncs diff against the last project the
   * container holds; without this they would write the container's own files
   * back into it, over anything a process wrote there since the read.
   */
  const recordContainerProject = (instance: WebContainer, project: WorkspaceProject) => {
    if (mountedInstanceRef.current === instance) {
      lastSyncedProjectRef.current = cloneProjectForSync(project);
    }
  };

  /**
   * Schedules a reverse sync. Requests within the debounce window coalesce, and
   * a newer request, a reset or turning reverse sync off makes an older one
   * return unapplied.
   */
  const requestReverseSync = (instance: WebContainer, generation: number) => {
    if (typeof window === "undefined" || !reverseSyncEnabledRef.current) {
      return;
    }

    const requestId = ++reverseSyncRequestRef.current;

    if (reverseSyncTimeoutRef.current !== null) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
    }

    reverseSyncTimeoutRef.current = window.setTimeout(() => {
      reverseSyncTimeoutRef.current = null;
      const {
        getProject,
        getWorkspaceRevision,
        isRuntimeGenerationActive,
        reconcileExternalProject,
        reportErrorFor,
        shouldReverseSync,
      } = optionsRef.current;

      void (async () => {
        if (!shouldReverseSync()) {
          return;
        }

        if (!isRuntimeGenerationActive(generation)) {
          return;
        }

        await flushWorkspaceSync({ instance });
        await runSerializedRuntimeTask({
          instance,
          task: async () => {
            if (
              requestId !== reverseSyncRequestRef.current ||
              !isRuntimeGenerationActive(generation)
            ) {
              return;
            }

            const workspaceRevision = getWorkspaceRevision();
            const currentProject = getProject();
            const nextProject = await readWorkspaceProject(instance, currentProject);

            if (
              requestId !== reverseSyncRequestRef.current ||
              !isRuntimeGenerationActive(generation)
            ) {
              return;
            }

            // An editor/store mutation landed while the recursive read was in
            // flight. Let its forward sync finish, then read a converged tree.
            if (workspaceRevision !== getWorkspaceRevision()) {
              requestReverseSync(instance, generation);
              return;
            }

            // The container holds nextProject, so the forward sync that the
            // reconcile below triggers must not write it back.
            recordContainerProject(instance, nextProject);
            if (!areWorkspaceProjectsEqual(currentProject, nextProject)) {
              reconcileExternalProject(nextProject);
            }
          },
        });
      })().catch(reportErrorFor(generation));
    }, WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
  };

  /** Clears a queued reverse sync; the new request ID makes one in flight return unapplied. */
  const cancelPendingReverseSync = () => {
    reverseSyncRequestRef.current += 1;
    if (typeof window !== "undefined" && reverseSyncTimeoutRef.current !== null) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
      reverseSyncTimeoutRef.current = null;
    }
  };

  const setReverseSyncEnabled = (enabled: boolean) => {
    reverseSyncEnabledRef.current = enabled;
    if (!enabled) {
      cancelPendingReverseSync();
    }
  };

  const resetWorkspaceSync = () => {
    cancelPendingReverseSync();
    syncGenerationRef.current += 1;
    stopFsWatch();
    clearFileSyncTimer();
    forwardSyncWritesRef.current.clear();
    queuedFilesRef.current.clear();
    for (const waiter of fileSyncWaitersRef.current) waiter.resolve();
    fileSyncWaitersRef.current = [];
    mountedInstanceRef.current = null;
    lastSyncedProjectRef.current = null;
    queuedProjectRef.current = null;
    syncQueueRef.current = Promise.resolve();
  };

  return {
    ensureProjectMounted,
    flushWorkspaceSync,
    isFsWatchActive,
    isProjectMounted,
    queueFileSync,
    queueProjectSync,
    requestReverseSync,
    runSerializedRuntimeTask,
    resetWorkspaceSync,
    setReverseSyncEnabled,
  };
}

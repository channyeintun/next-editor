import { useLayoutEffect, useRef } from "react";
import type { IFSWatcher, WebContainer } from "@webcontainer/api";
import {
  createWorkspaceTree,
  shouldIgnoreRuntimeImportPath,
  syncWorkspaceProject,
} from "./webContainerRuntimeSupport";
import { normalizeWorkspacePath, type WorkspaceProject } from "../types/workspace";

// How long a forward-sync write suppresses watch events for its path. The
// container delivers watch events for our own writes within milliseconds; the
// window only absorbs scheduling jitter. A container-side write to the same
// path inside the window is missed here but still converges through the
// server-ready / Enter-key reverse-sync triggers, and suppression is purely an
// optimization — a spurious reverse sync no-ops on the project-equality check.
const FORWARD_SYNC_ECHO_WINDOW_MS = 1000;

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
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const syncGenerationRef = useRef(0);
  const fsWatcherRef = useRef<IFSWatcher | null>(null);
  const forwardSyncWritesRef = useRef<Map<string, number>>(new Map());
  const onExternalFileChangeRef = useRef(onExternalFileChange);

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
    await instance.mount(createWorkspaceTree(project));

    if (syncGenerationRef.current !== generation) {
      return;
    }

    mountedInstanceRef.current = instance;
    lastSyncedProjectRef.current = project;
    queuedProjectRef.current = null;
    hasMountedProjectRef.current = true;

    // Started only after the mount finishes so the initial tree never echoes
    // back as external changes.
    startFsWatch(instance);
  };

  const queueProjectSync = ({ instance, project }: QueueProjectSyncOptions) => {
    if (!hasMountedProjectRef.current || mountedInstanceRef.current !== instance) {
      return Promise.resolve();
    }

    const generation = syncGenerationRef.current;
    queuedProjectRef.current = project;

    const runQueuedSync = async () => {
      while (queuedProjectRef.current && syncGenerationRef.current === generation) {
        const nextProject = queuedProjectRef.current;
        queuedProjectRef.current = null;

        if (
          !nextProject ||
          mountedInstanceRef.current !== instance ||
          syncGenerationRef.current !== generation ||
          lastSyncedProjectRef.current === nextProject
        ) {
          continue;
        }

        await syncWorkspaceProject(
          instance,
          lastSyncedProjectRef.current,
          nextProject,
          recordForwardSyncWrite,
        );

        if (syncGenerationRef.current !== generation) {
          return;
        }

        lastSyncedProjectRef.current = nextProject;
      }
    };

    syncQueueRef.current = syncQueueRef.current.then(runQueuedSync, runQueuedSync);

    return syncQueueRef.current;
  };

  const resetWorkspaceSync = () => {
    syncGenerationRef.current += 1;
    stopFsWatch();
    forwardSyncWritesRef.current.clear();
    hasMountedProjectRef.current = false;
    mountedInstanceRef.current = null;
    lastSyncedProjectRef.current = null;
    queuedProjectRef.current = null;
    syncQueueRef.current = Promise.resolve();
  };

  return {
    hasMountedProjectRef,
    ensureProjectMounted,
    isFsWatchActive,
    queueProjectSync,
    resetWorkspaceSync,
  };
}

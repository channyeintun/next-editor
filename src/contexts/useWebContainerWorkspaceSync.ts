import { useRef } from "react";
import type { WebContainer } from "@webcontainer/api";
import { createWorkspaceTree, syncWorkspaceProject } from "./webContainerRuntimeSupport";
import type { WorkspaceProject } from "../types/workspace";

interface EnsureProjectMountedOptions {
  instance: WebContainer;
  project: WorkspaceProject;
  onMountStart?: () => void;
}

interface QueueProjectSyncOptions {
  instance: WebContainer;
  project: WorkspaceProject;
}

export function useWebContainerWorkspaceSync() {
  const hasMountedProjectRef = useRef(false);
  const mountedInstanceRef = useRef<WebContainer | null>(null);
  const lastSyncedProjectRef = useRef<WorkspaceProject | null>(null);
  const queuedProjectRef = useRef<WorkspaceProject | null>(null);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const syncGenerationRef = useRef(0);

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

        await syncWorkspaceProject(instance, lastSyncedProjectRef.current, nextProject);

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
    hasMountedProjectRef.current = false;
    mountedInstanceRef.current = null;
    lastSyncedProjectRef.current = null;
    queuedProjectRef.current = null;
    syncQueueRef.current = Promise.resolve();
  };

  return {
    hasMountedProjectRef,
    ensureProjectMounted,
    queueProjectSync,
    resetWorkspaceSync,
  };
}

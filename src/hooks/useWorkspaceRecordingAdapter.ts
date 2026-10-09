import { useEffect, useRef } from "react";
import { usePreviewAdapterHandle } from "../contexts/PreviewAdapterHandleContext";
import { isNonZeroWidthDelta, type WorkspaceRecordingSnapshot } from "../types/workspace";
import {
  useWebContainerRuntimeSaveWorkspace,
  useWebContainerRuntimeSnapshotGetter,
} from "./useWebContainerRuntime";
import { useWorkspaceActions } from "./useWorkspace";

/**
 * The workspace side of recording and replay. getWorkspaceSnapshot reads the workspace
 * store for the machine, reusing its last snapshot while nothing it holds has changed;
 * applyWorkspaceSnapshot loads a replayed snapshot back into the store. The workspace
 * events that load sets off are suppressed until the next task
 * (suppressWorkspaceEventsRef), so playback writes are not recaptured as new edits.
 */
export function useWorkspaceRecordingAdapter() {
  const {
    getProject,
    getActiveFilePath,
    getCollapsedFolders,
    getSidebarScrollTop,
    getSidebarWidth,
    getSidebarCollapsed,
    loadProject,
    setSidebarWidth,
    startSidebarCollapsed,
  } = useWorkspaceActions();
  const saveRuntimeWorkspace = useWebContainerRuntimeSaveWorkspace();
  const getRuntimeRecordingSnapshot = useWebContainerRuntimeSnapshotGetter();
  const previewHandle = usePreviewAdapterHandle();
  const workspaceSnapshotRef = useRef<WorkspaceRecordingSnapshot | null>(null);
  const suppressWorkspaceEventsRef = useRef(false);
  const clearWorkspaceEventSuppressionTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clearWorkspaceEventSuppressionTimeoutRef.current !== null) {
        window.clearTimeout(clearWorkspaceEventSuppressionTimeoutRef.current);
      }
    };
  }, []);

  const suppressWorkspaceEvents = () => {
    suppressWorkspaceEventsRef.current = true;

    if (clearWorkspaceEventSuppressionTimeoutRef.current !== null) {
      window.clearTimeout(clearWorkspaceEventSuppressionTimeoutRef.current);
    }

    clearWorkspaceEventSuppressionTimeoutRef.current = window.setTimeout(() => {
      suppressWorkspaceEventsRef.current = false;
      clearWorkspaceEventSuppressionTimeoutRef.current = null;
    }, 0);
  };

  const getWorkspaceSnapshot = (): WorkspaceRecordingSnapshot => {
    const project = getProject();
    const activeFilePath = getActiveFilePath();
    const collapsedFolders = getCollapsedFolders();
    const sidebarScrollTop = getSidebarScrollTop();
    const sidebarCollapsed = getSidebarCollapsed();
    const cachedSnapshot = workspaceSnapshotRef.current;

    if (
      cachedSnapshot &&
      cachedSnapshot.project === project &&
      cachedSnapshot.activeFilePath === activeFilePath &&
      cachedSnapshot.collapsedFolders === collapsedFolders &&
      (cachedSnapshot.sidebarScrollTop ?? 0) === sidebarScrollTop &&
      (cachedSnapshot.sidebarCollapsed ?? false) === sidebarCollapsed
    ) {
      return cachedSnapshot;
    }

    const nextSnapshot = {
      project,
      activeFilePath,
      collapsedFolders,
      sidebarScrollTop,
      sidebarCollapsed,
    } satisfies WorkspaceRecordingSnapshot;

    workspaceSnapshotRef.current = nextSnapshot;
    return nextSnapshot;
  };

  const applyWorkspaceSnapshot = (snapshot: WorkspaceRecordingSnapshot) => {
    suppressWorkspaceEvents();
    loadProject(
      snapshot.project,
      snapshot.activeFilePath,
      snapshot.collapsedFolders ?? [],
      snapshot.sidebarScrollTop ?? 0,
    );
    // Only when the recording says so. Absent — every recording made before
    // this, and every lesson that does not ask — the viewer's own preference
    // stands, and even when it is present this is the opening frame rather
    // than a lock: the toggle keeps working mid-replay, and nothing is
    // written back to their storage.
    if (typeof snapshot.sidebarCollapsed === "boolean") {
      startSidebarCollapsed(snapshot.sidebarCollapsed);
    }
    if (isNonZeroWidthDelta(snapshot.sidebarWidthDelta)) {
      setSidebarWidth(getSidebarWidth() + snapshot.sidebarWidthDelta);
    }
    if (isNonZeroWidthDelta(snapshot.previewDockWidthDelta)) {
      previewHandle.dockWidthDeltaApplier.current?.(snapshot.previewDockWidthDelta);
    }
    // The runtime's workspace sync already moves these files into the container.
    // Saving as well re-runs a finished run-on-save runner on them, so the live
    // console, shown whenever playback is not playing (ready, paused, ended),
    // follows the replayed workspace, including a next lesson loaded in place
    // under the same starter project id. Only when the runner has not already run
    // this code: a pause re-applies the workspace it shows, and file switches and
    // sidebar scrolls replay as whole snapshots. Only for a runtime that has been
    // started (any status but idle): starting one is the auto-start's call
    // (allowAmbientStart, runOnStartup, browser support) or the viewer's, never
    // the replay's.
    if (getRuntimeRecordingSnapshot().status !== "idle") {
      void saveRuntimeWorkspace({ rerunOnlyIfChanged: true });
    }
  };

  return { getWorkspaceSnapshot, applyWorkspaceSnapshot, suppressWorkspaceEventsRef };
}

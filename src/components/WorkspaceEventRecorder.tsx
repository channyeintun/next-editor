import { useEffect, useRef } from "react";
import {
  useWorkspaceExternalProjectVersion,
  useWorkspaceProjectVersion,
  useWorkspaceSidebarState,
} from "../hooks/useWorkspace";

interface WorkspaceEventRecorderProps {
  handleWorkspaceEvent: (event?: { sidebarWidthDelta?: number }) => void;
  isRecording: boolean;
  shouldTrackWorkspaceChanges: boolean;
}

/**
 * Bridges workspace-store changes into machine WORKSPACE_EVENTs. While recording
 * they are captured into the workspace track; while a recording is loaded they
 * signal a manual workspace change, which pauses playback and detaches the
 * replayed workspace.
 *
 * Project bumps from `reconcileExternalProject` (a WebContainer process or a
 * remote collaborator wrote files) are not local-user actions: they still fire
 * while recording so the workspace track captures them, but during playback they
 * are absorbed — a runtime booting in the background (e.g. `pnpm install`
 * creating a lockfile) must not pause the lesson.
 */
export function WorkspaceEventRecorder({
  handleWorkspaceEvent,
  isRecording,
  shouldTrackWorkspaceChanges,
}: WorkspaceEventRecorderProps) {
  const sidebarState = useWorkspaceSidebarState();
  const projectVersion = useWorkspaceProjectVersion();
  const externalProjectVersion = useWorkspaceExternalProjectVersion();
  const previousSidebarStateRef = useRef(sidebarState);
  const previousProjectVersionRef = useRef(projectVersion);
  const previousExternalProjectVersionRef = useRef(externalProjectVersion);
  const wasTrackingRef = useRef(false);

  useEffect(() => {
    const syncObservedState = () => {
      previousSidebarStateRef.current = sidebarState;
      previousProjectVersionRef.current = projectVersion;
      previousExternalProjectVersionRef.current = externalProjectVersion;
    };

    if (!shouldTrackWorkspaceChanges) {
      syncObservedState();
      wasTrackingRef.current = false;
      return;
    }

    if (!wasTrackingRef.current) {
      syncObservedState();
      wasTrackingRef.current = true;
      return;
    }

    if (
      previousSidebarStateRef.current !== sidebarState ||
      previousProjectVersionRef.current !== projectVersion
    ) {
      const sidebarWidthDelta =
        sidebarState.sidebarWidth - previousSidebarStateRef.current.sidebarWidth;
      const isExternalSyncChange =
        previousExternalProjectVersionRef.current !== externalProjectVersion;
      syncObservedState();

      // A genuine width delta is always a local resize, so it fires even when an
      // external reconcile lands in the same commit.
      if (isExternalSyncChange && !isRecording && sidebarWidthDelta === 0) {
        return;
      }

      handleWorkspaceEvent({ sidebarWidthDelta });
    }
  }, [
    externalProjectVersion,
    handleWorkspaceEvent,
    isRecording,
    projectVersion,
    shouldTrackWorkspaceChanges,
    sidebarState,
  ]);

  return null;
}

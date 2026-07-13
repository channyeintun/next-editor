import { useSelector } from "@xstate/store-react";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import { selectPlaybackSnapshot } from "../stores/runtimePanelStore";
import { useNextEditorMetadata } from "./useNextEditorContext";
import type { RuntimeRecordingSnapshot } from "../types/runtime";

export interface RuntimeDockRecordedSnapshotResult {
  recordedRuntimeSnapshot: RuntimeRecordingSnapshot | null;
  isPlaybackSnapshotActive: boolean;
}

/**
 * Resolves the recorded runtime dock snapshot (if any) for the currently playing
 * recording. Shared by the runtime dock UI and the code editor so both agree on
 * which recorded values (activeTab, isCollapsed, isFullHeight, ...) to display.
 */
export function useRuntimeDockRecordedSnapshot(): RuntimeDockRecordedSnapshotResult {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const playbackRuntimeSnapshot = useSelector(runtimePanelStore, (s) =>
    selectPlaybackSnapshot(s.context),
  );
  const { currentRecording, isPlaying, isRecording } = useNextEditorMetadata();

  const recordedRuntimeSnapshot =
    isPlaying && !isRecording
      ? (playbackRuntimeSnapshot ??
        currentRecording?.runtimeEvents?.[0]?.snapshot ??
        currentRecording?.runtimeSnapshot ??
        null)
      : null;

  return {
    recordedRuntimeSnapshot,
    isPlaybackSnapshotActive: Boolean(recordedRuntimeSnapshot),
  };
}

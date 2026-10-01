import { useSelector } from "@xstate/store-react";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import {
  selectActiveTab,
  selectIsCollapsed,
  selectIsFullHeight,
  selectViewerFullHeight,
} from "../stores/runtimePanelStore";
import type { RuntimeDockTab, RuntimeRecordingSnapshot } from "../types/runtime";
import { useNextEditorMetadata } from "./useNextEditorContext";
import { useRuntimeDockRecordedSnapshot } from "./useRuntimeDockRecordedSnapshot";

export interface RuntimeDockLayout {
  /** The live tab, which is what a recording captures. */
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  recordedRuntimeSnapshot: RuntimeRecordingSnapshot | null;
  isPlaybackSnapshotActive: boolean;
  /** The tab on screen: the recorded one while a replay is shown ("runner" when it has none). */
  displayActiveTab: RuntimeDockTab;
  displayIsCollapsed: boolean;
  /** The height on screen: the viewer's own choice once they made one during this replay. */
  displayIsFullHeight: boolean;
  /**
   * The full-height toggle. While a replay plays, or once the viewer has chosen a
   * height during one, it flips the viewer's choice; otherwise it flips the live
   * value, as record mode always has.
   */
  toggleFullHeight: () => void;
}

/**
 * The runtime dock's layout, live and on screen. During playback the dock
 * shows the recorded tab, collapse and height; the live values are still what
 * a recording captures, so both are returned. Full height is the exception: the
 * viewer may toggle it mid-replay, and their choice (the store's
 * viewerFullHeight) then stays on screen until the editor leaves playback.
 */
export function useRuntimeDockLayout(): RuntimeDockLayout {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const activeTab = useSelector(runtimePanelStore, (s) => selectActiveTab(s.context));
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const viewerFullHeight = useSelector(runtimePanelStore, (s) => selectViewerFullHeight(s.context));
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();
  const { isRecording } = useNextEditorMetadata();

  // A take always shows (and records) the live height, whatever a replay left behind.
  const hasViewerFullHeight = viewerFullHeight !== null && !isRecording;
  const displayIsFullHeight = hasViewerFullHeight
    ? viewerFullHeight
    : isPlaybackSnapshotActive
      ? (recordedRuntimeSnapshot?.isFullHeight ?? false)
      : isFullHeight;

  const toggleFullHeight = () => {
    if (isPlaybackSnapshotActive || hasViewerFullHeight) {
      runtimePanelStore.trigger.setViewerFullHeight({ fullHeight: !displayIsFullHeight });
      return;
    }
    runtimePanelStore.trigger.setIsFullHeight({
      fullHeight: !runtimePanelStore.getSnapshot().context.isFullHeight,
    });
  };

  return {
    activeTab,
    isCollapsed,
    isFullHeight,
    recordedRuntimeSnapshot,
    isPlaybackSnapshotActive,
    displayActiveTab: isPlaybackSnapshotActive
      ? (recordedRuntimeSnapshot?.activeTab ?? "runner")
      : activeTab,
    displayIsCollapsed: isPlaybackSnapshotActive
      ? (recordedRuntimeSnapshot?.isCollapsed ?? false)
      : isCollapsed,
    displayIsFullHeight,
    toggleFullHeight,
  };
}

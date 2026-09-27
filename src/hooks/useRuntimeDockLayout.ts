import { useSelector } from "@xstate/store-react";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import {
  selectActiveTab,
  selectIsCollapsed,
  selectIsFullHeight,
} from "../stores/runtimePanelStore";
import type { RuntimeDockTab, RuntimeRecordingSnapshot } from "../types/runtime";
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
  displayIsFullHeight: boolean;
}

/**
 * The runtime dock's layout, live and on screen. During playback the dock
 * shows the recorded tab, collapse and height; the live values are still what
 * a recording captures, so both are returned.
 */
export function useRuntimeDockLayout(): RuntimeDockLayout {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const activeTab = useSelector(runtimePanelStore, (s) => selectActiveTab(s.context));
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();

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
    displayIsFullHeight: isPlaybackSnapshotActive
      ? (recordedRuntimeSnapshot?.isFullHeight ?? false)
      : isFullHeight,
  };
}

import { useEffect } from "react";
import { useSelector } from "@xstate/store-react";
import type { EditorActorRef } from "../core/src/useNextEditor";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import {
  selectActiveTab,
  selectIsCollapsed,
  selectIsFullHeight,
  selectViewerFullHeight,
} from "../stores/runtimePanelStore";
import type { RuntimeDockTab, RuntimeRecordingSnapshot } from "../types/runtime";
import { useNextEditorActions, useNextEditorMetadata } from "./useNextEditorContext";
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
   * The dock takes the whole editor column: it is shown full height and not
   * collapsed. The editor hides behind it while this holds.
   */
  fillsColumn: boolean;
  /**
   * The full-height toggle. While a replay is loaded (playing, paused, ready or
   * ended), or once the viewer has chosen a height during one, it flips the
   * viewer's choice; otherwise (record mode, idle) it flips the live value.
   */
  toggleFullHeight: () => void;
  /**
   * The collapse toggle. While a replay is loaded it collapses or expands the dock on
   * screen, the replayed frame included, until the recording next collapses or expands
   * it; otherwise (record mode, idle) it flips the live collapse, which recordings capture.
   */
  toggleCollapsed: () => void;
}

/**
 * The runtime dock's layout, live and on screen. During playback the dock
 * shows the recorded tab, collapse and height; the live values are still what
 * a recording captures, so both are returned. The viewer may collapse or expand
 * the dock mid-replay: that holds until the recording next collapses or expands
 * it (machine/viewerPanels.ts). They may also toggle full height, and that choice
 * (the store's viewerFullHeight) stays on screen until the editor leaves
 * playback, including a reload of the same lesson (see useEndViewerDockOverride).
 */
export function useRuntimeDockLayout(): RuntimeDockLayout {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const activeTab = useSelector(runtimePanelStore, (s) => selectActiveTab(s.context));
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const viewerFullHeight = useSelector(runtimePanelStore, (s) => selectViewerFullHeight(s.context));
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();
  const { handleViewerPanelViewChange } = useNextEditorActions();
  const { isRecording, isReplayLoaded } = useNextEditorMetadata((m) => ({
    isRecording: m.isRecording,
    isReplayLoaded: m.isReplayLoaded,
  }));

  // A take always shows (and records) the live height, whatever a replay left behind.
  const hasViewerFullHeight = viewerFullHeight !== null && !isRecording;
  const displayIsFullHeight = hasViewerFullHeight
    ? viewerFullHeight
    : isPlaybackSnapshotActive
      ? (recordedRuntimeSnapshot?.isFullHeight ?? false)
      : isFullHeight;

  const displayIsCollapsed = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isCollapsed ?? false)
    : isCollapsed;

  const toggleFullHeight = () => {
    // Any press while a replay is loaded is the viewer's, even before the first play or
    // while paused, so resuming keeps it rather than snapping back to the recording.
    if ((isReplayLoaded && !isRecording) || hasViewerFullHeight) {
      runtimePanelStore.trigger.setViewerFullHeight({ fullHeight: !displayIsFullHeight });
      return;
    }
    runtimePanelStore.trigger.setIsFullHeight({
      fullHeight: !runtimePanelStore.getSnapshot().context.isFullHeight,
    });
  };

  const toggleCollapsed = () => {
    // Any press while a replay is loaded is the viewer's, as with the height: the dock they
    // see changes, and the replay keeps it until the recording changes it.
    if (isReplayLoaded && !isRecording) {
      runtimePanelStore.trigger.setViewerCollapsed({ collapsed: !displayIsCollapsed });
      handleViewerPanelViewChange("runtimeDock");
      return;
    }
    runtimePanelStore.trigger.setIsCollapsed({
      collapsed: !runtimePanelStore.getSnapshot().context.isCollapsed,
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
    displayIsCollapsed,
    displayIsFullHeight,
    fillsColumn: displayIsFullHeight && !displayIsCollapsed,
    toggleFullHeight,
    toggleCollapsed,
  };
}

/**
 * Ends the viewer's full-height choice for the runtime dock (runtimePanelStore's
 * viewerFullHeight) when the editor leaves playback. It lasts for as long as one
 * recording stays loaded, through play, pause, seeking, stopping and the end; it ends
 * when another recording is loaded, the lesson is unloaded, or a take starts, since
 * each of those leaves `playback`. Any reload of the same lesson ends it too: the URL
 * loader's whole-file retry after a dropped stream, and a late narration blob that
 * sends a finished take back through `loading`. Each of those restarts the replay at
 * `ready` and ends the whiteboard's playback session as well, so the dock starting
 * over with them is deliberate. The actor is subscribed to directly rather than
 * through a selector, so a brief `loading` between two recordings is never missed.
 */
export function useEndViewerDockOverride(actorRef: EditorActorRef): void {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  useEffect(() => {
    const subscription = actorRef.subscribe((snapshot) => {
      if (
        !snapshot.matches("playback") &&
        runtimePanelStore.getSnapshot().context.viewerFullHeight !== null
      ) {
        runtimePanelStore.trigger.clearViewerFullHeight();
      }
    });
    return () => subscription.unsubscribe();
  }, [actorRef, runtimePanelStore]);
}

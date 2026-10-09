import { useEffect, useRef } from "react";
import { areStructuredDataEqual } from "../../core/src/utils/equality";
import type { Recording } from "../../core/src/types";
import type { RuntimePanelStoreInstance } from "../../stores/runtimePanelStore";

interface RuntimeDockRecordingOptions {
  isRecording: boolean;
  isPlaybackSnapshotActive: boolean;
  currentRecording: Recording | null;
  handleRuntimeEvent: () => void;
  runtimePanelStore: RuntimePanelStoreInstance;
}

/**
 * The runtime dock's recording glue, shared by both docks. While a take is
 * recorded, every structural change to the dock's recordable state is a
 * RUNTIME_EVENT; a structurally equal new object is not, and nothing is sent
 * while a replay is on screen. Each dock passes its own state object, so the
 * fields that count as a change stay the dock's. With no recording loaded, any
 * playback snapshot left behind is cleared.
 */
export function useRuntimeDockRecording<State extends object>(
  state: State,
  {
    isRecording,
    isPlaybackSnapshotActive,
    currentRecording,
    handleRuntimeEvent,
    runtimePanelStore,
  }: RuntimeDockRecordingOptions,
): void {
  const previousStateRef = useRef<State | null>(null);

  useEffect(() => {
    if (!currentRecording) {
      runtimePanelStore.trigger.setPlaybackSnapshot({ snapshot: null });
    }
  }, [currentRecording, runtimePanelStore]);

  useEffect(() => {
    if (!isRecording || isPlaybackSnapshotActive) {
      previousStateRef.current = state;
      return;
    }

    if (previousStateRef.current === null) {
      previousStateRef.current = state;
      return;
    }

    if (!areStructuredDataEqual(previousStateRef.current, state)) {
      previousStateRef.current = state;
      handleRuntimeEvent();
    }
  }, [handleRuntimeEvent, isPlaybackSnapshotActive, isRecording, state]);
}

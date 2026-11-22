import { useEffect } from "react";
import type { Recording } from "../core/src";
import { whenCodeEditorLoaded } from "../components/codeEditorLoader";
import {
  prefetchWhiteboardPanel,
  prefetchWhiteboardPanelWhenIdle,
} from "../components/whiteboardPanelLoader";
import { prefersSavingData } from "../utils/saveData";

/** Whether `recording` opens the whiteboard at some point. */
function opensWhiteboard(recording: Recording): boolean {
  return recording.whiteboardEvents?.some((event) => event.isOpen === true) ?? false;
}

/**
 * Warms the whiteboard (Excalidraw) chunk for a lesson whose recording opens the board,
 * so opening it mid-playback does not stall while the chunk downloads and evaluates. It
 * waits for the code editor's chunk, so it never competes with it, then starts at idle, or
 * at once while the lesson plays. The narration is streamed, and its start is loaded
 * ahead of Play at the same moment (useNarrationWarmUp); neither is waited for, except
 * while the lesson is held for its narration (`isBuffering`): the learner is waiting for
 * those bytes, and the chunk must not share a slow connection with them. A data-saver
 * connection keeps the old behavior: the chunk downloads when the board first opens.
 */
export function useWhiteboardPanelPrefetch(
  recording: Recording | null | undefined,
  isPlaying: boolean,
  isBuffering: boolean,
): void {
  const ready = recording ? opensWhiteboard(recording) : false;

  useEffect(() => {
    if (!ready || isBuffering || prefersSavingData()) return;
    let cancelled = false;
    let cancelIdlePrefetch: (() => void) | undefined;
    void whenCodeEditorLoaded().then(() => {
      if (cancelled) return;
      if (isPlaying) {
        prefetchWhiteboardPanel();
      } else {
        cancelIdlePrefetch = prefetchWhiteboardPanelWhenIdle();
      }
    });
    return () => {
      cancelled = true;
      cancelIdlePrefetch?.();
    };
  }, [ready, isPlaying, isBuffering]);
}

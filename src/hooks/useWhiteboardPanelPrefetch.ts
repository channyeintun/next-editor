import { useEffect } from "react";
import type { Recording } from "../core/src";
import { whenCodeEditorLoaded } from "../components/codeEditorLoader";
import {
  prefetchWhiteboardPanel,
  prefetchWhiteboardPanelWhenIdle,
} from "../components/whiteboardPanelLoader";

/** Whether `recording` opens the whiteboard at some point. */
function opensWhiteboard(recording: Recording): boolean {
  return recording.whiteboardEvents?.some((event) => event.isOpen === true) ?? false;
}

/** Whether the viewer asked the browser to save data, where the browser says so. */
function prefersSavingData(): boolean {
  return (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/**
 * Warms the whiteboard (Excalidraw) chunk for a lesson whose recording opens the board,
 * so opening it mid-playback does not stall while the chunk downloads and evaluates. It
 * waits for the code editor's chunk, so it never competes with it, then starts at idle, or
 * at once while the lesson plays. The narration is no longer waited for: the player streams
 * it while the lesson plays, and nothing of it downloads before Play. A data-saver
 * connection keeps the old behavior: the chunk downloads when the board first opens.
 */
export function useWhiteboardPanelPrefetch(
  recording: Recording | null | undefined,
  isPlaying: boolean,
): void {
  const ready = recording ? opensWhiteboard(recording) : false;

  useEffect(() => {
    if (!ready || prefersSavingData()) return;
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
  }, [ready, isPlaying]);
}

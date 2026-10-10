import { runWhenIdle } from "../utils/idle";

let whiteboardPanelPromise: ReturnType<typeof importWhiteboardPanel> | null = null;

// The longest an idle prefetch waits for the main thread to go idle before it starts anyway.
const PREFETCH_IDLE_TIMEOUT_MS = 2000;

function importWhiteboardPanel() {
  return import("./WhiteboardPanel");
}

/**
 * Share one import between React.lazy, Studio's preflight and the playback
 * prefetch. Studio warms the heavy Excalidraw chunk before the recording clock
 * starts, so the first whiteboard action doesn't disappear behind a cold module
 * load. A failed import is forgotten, so opening the board fetches it again
 * instead of repeating a failed warm-up.
 */
export function loadWhiteboardPanel() {
  whiteboardPanelPromise ??= importWhiteboardPanel().catch((error: unknown) => {
    whiteboardPanelPromise = null;
    throw error;
  });
  return whiteboardPanelPromise;
}

/**
 * Starts downloading the whiteboard chunk now, for a lesson that will open the
 * board, so the board does not stall playback while Excalidraw downloads and
 * evaluates. A failure is left to the panel's own import when the board opens.
 */
export function prefetchWhiteboardPanel(): void {
  loadWhiteboardPanel().catch(() => {});
}

/**
 * prefetchWhiteboardPanel, the next time the main thread is idle. Returns a
 * function that cancels a prefetch that has not started yet.
 */
export function prefetchWhiteboardPanelWhenIdle(): () => void {
  return runWhenIdle(prefetchWhiteboardPanel, PREFETCH_IDLE_TIMEOUT_MS);
}

import type { TextAnchor } from "./plan";

/**
 * Monaco-free primitives shared by the driver, Performer, and controller.
 * Kept out of driver.ts so unit tests (and the Performer) never pull the
 * Monaco runtime into their module graph.
 */

export class StudioActionError extends Error {
  readonly detail?: Record<string, unknown>;

  constructor(message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "StudioActionError";
    this.detail = detail;
  }
}

/** What every render step fails with once the render's signal has aborted. */
export const RENDER_CANCELLED_MESSAGE = "The render was cancelled";

export function cancelledError(): StudioActionError {
  return new StudioActionError(RENDER_CANCELLED_MESSAGE);
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WaitUntilOptions {
  timeoutMs: number;
  signal: AbortSignal;
  description: string;
  intervalMs?: number;
}

export async function waitUntil(
  predicate: () => boolean,
  { timeoutMs, signal, description, intervalMs = 16 }: WaitUntilOptions,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    throwIfAborted(signal);
    if (predicate()) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new StudioActionError(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await abortableSleep(intervalMs, signal);
  }
}

// One synthetic pointer sample per ~16ms (≈60fps). The reference human
// recording (human-interactions.ne) samples the cursor at a 16–17ms median
// during active motion; the lightweight cursor-events track is captured at
// full rate (only full editor frames are throttled), so stepping this fine is
// what makes the recorded motion read as a hand rather than a 30fps slideshow.
export const CURSOR_STEP_MS = 16;

/**
 * Run an eased animation one step per CURSOR_STEP_MS: each step checks the
 * signal, measures progress (0→1) over `durationMs`, and hands `step` the
 * eased value, ending on the step that reaches 1. A zero duration still steps
 * once, straight to the end, so a zero-length move lands where it was going.
 * Pointer moves, drags and editor scrolls all run on it, so their recorded
 * cadence has one home.
 */
export async function tween(
  durationMs: number,
  ease: (progress: number) => number,
  signal: AbortSignal,
  step: (eased: number, progress: number) => void,
): Promise<void> {
  const started = performance.now();
  for (;;) {
    throwIfAborted(signal);
    const progress = durationMs > 0 ? Math.min(1, (performance.now() - started) / durationMs) : 1;
    step(ease(progress), progress);
    if (progress >= 1) {
      return;
    }
    // setTimeout stepping (not rAF): rAF pauses in background tabs and would
    // stall an unattended render mid-tween.
    await abortableSleep(CURSOR_STEP_MS, signal);
  }
}

/**
 * Resolve a text anchor to an insertion offset: the end of the `occurrence`-th
 * exact match of `after` ("" anchors the start of the file). Returns null when
 * the occurrence does not exist — callers must fail, not guess.
 */
export function resolveAnchorOffset(content: string, anchor: TextAnchor): number | null {
  if (anchor.after === "") {
    return 0;
  }
  let index = -1;
  for (let found = 0; found < anchor.occurrence; found++) {
    index = content.indexOf(anchor.after, index + 1);
    if (index === -1) {
      return null;
    }
  }
  return index + anchor.after.length;
}

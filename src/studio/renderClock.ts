import type { TimeSource } from "../core/src/machine/timeSource";
import { abortableSleep, cancelledError } from "./async";

/**
 * The clock a studio render performs on.
 *
 * A render waits for two kinds of things. Performance waits are part of the
 * lesson itself: the wait until an action's planned time, a typing chunk's
 * delay, every pointer step, a drag, a rest, a whiteboard draw frame, a
 * fixture run's simulated latency. Real waits are for the page or the network:
 * React committing, Monaco showing a model, xterm parsing output, a preview
 * frame answering, a live run, every deadline. Only performance waits go
 * through this clock; real waits keep the page's own timers in every render.
 *
 * The real clock is the page's clock, and a render on it takes as long as the
 * lesson does. The virtual clock is a number that only `sleep` moves, so a
 * lesson with nothing real to wait for (no live preview, no runtime that
 * boots, no network run) performs as fast as the page can follow, and the take
 * still records every event at the time the lesson planned for it: the take
 * reads this same clock (START_RECORDING.timeSource).
 *
 * What one settle does not cover, and how a virtual render drains each:
 * - xterm parses a write on a timer and paints its rows on an animation
 *   frame. The performer gives one real frame (`frame`) at the start of every
 *   action, after the wait to its planned time, so whatever an action reads
 *   from the page (a console line's painted end) is on screen.
 * - Monaco applies a horizontal reveal only when it renders. The editor driver
 *   calls `editor.render()` after each typing chunk and each drag step, so a
 *   horizontal scroll is recorded at the chunk that caused it.
 * - Excalidraw reports its canvas through a real 100 ms throttle in the
 *   whiteboard controller, the one app timer that records. After the settle
 *   that follows each whiteboard step the stage driver flushes that throttle,
 *   so the report is stamped at its cause and not wherever virtual time has
 *   reached when the timer fires.
 * - Nothing recorded or read by the driver waits on a CSS transition, so no
 *   motion is switched off.
 *
 * The virtual clock serves one sleeper at a time, which is how the driver
 * performs: one action after another, its one background action (a runtime
 * start) excluded from virtual renders.
 */

export type RenderClockKind = "real" | "virtual";

/**
 * What a render asks for: "full" runs it off the wall clock when it can
 * (runStudioRender's renderClockFor), "real" performs it in real time.
 */
export type RenderSpeed = "full" | "real";

export interface RenderClock extends TimeSource {
  readonly kind: RenderClockKind;
  /** A wait in PERFORMANCE time: typing delays, pointer steps, the wait to an action's planned time. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Let the page paint: one real animation frame. A no-op on the real clock. */
  frame(signal: AbortSignal): Promise<void>;
}

/** The page's own clock: today's timers, read at call time so tests that fake them fake this. */
export const REAL_RENDER_CLOCK: RenderClock = {
  kind: "real",
  perfNow: () => performance.now(),
  wallNow: () => Date.now(),
  sleep: abortableSleep,
  frame: () => Promise.resolve(),
};

// The longest a frame waits for the page to paint. A hidden tab runs no
// animation frames, and a render must not stall there.
const FRAME_FALLBACK_MS = 50;

interface BackgroundScheduler {
  postTask(callback: () => void, options: { priority: "background" }): Promise<unknown>;
}

/** Run `callback` as one task at background priority, after the page's own queued work. */
function postBackgroundTask(callback: () => void): void {
  const scheduler = (globalThis as { scheduler?: Partial<BackgroundScheduler> }).scheduler;
  if (typeof scheduler?.postTask === "function") {
    // React's scheduler posts its work at normal priority, and due timers
    // run as ordinary tasks, so a background task runs after both.
    void scheduler.postTask(callback, { priority: "background" }).catch(() => {});
    return;
  }
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    callback();
  };
  channel.port2.postMessage(null);
}

/** Resolve once `schedule` calls back; reject with the render's cancellation once `signal` aborts. */
function abortableCallback(
  signal: AbortSignal,
  schedule: (done: () => void) => () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    let cancel = () => {};
    const onAbort = () => {
      cancel();
      reject(cancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    cancel = schedule(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** Let the page finish what it has queued: one task at background priority. */
function settle(signal: AbortSignal): Promise<void> {
  return abortableCallback(signal, (done) => {
    let live = true;
    postBackgroundTask(() => {
      if (live) done();
    });
    return () => {
      live = false;
    };
  });
}

/** One real animation frame, or the fallback timer when the page runs none. */
function nextFrame(signal: AbortSignal): Promise<void> {
  return abortableCallback(signal, (done) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      window.clearTimeout(timer);
      done();
    };
    const frameId =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(finish)
        : null;
    const timer = window.setTimeout(finish, FRAME_FALLBACK_MS);
    return () => {
      finished = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      window.clearTimeout(timer);
    };
  });
}

/**
 * A clock whose time moves only when the render sleeps on it. It starts at the
 * page's own `performance.now()` (to the whole millisecond) and `Date.now()`,
 * so anything that still reads the page's clock against the take's start (the
 * studio's recording timer) starts sane; it drifts from there, by as much time
 * as the render saves.
 *
 * `sleep(ms)` first lets the page settle in real time while virtual time
 * stands still, then adds `ms`: whatever the last step caused is committed,
 * and recorded, at the step's own time.
 */
export function createVirtualRenderClock(): RenderClock {
  // A whole millisecond, so that times read against this start (a session's
  // origin, an action's planned time) come out exact rather than off by a
  // rounding error in the last bit.
  const startPerf = Math.floor(performance.now());
  const startWall = Date.now();
  let elapsedMs = 0;
  return {
    kind: "virtual",
    perfNow: () => startPerf + elapsedMs,
    wallNow: () => startWall + elapsedMs,
    async sleep(ms, signal) {
      await settle(signal);
      if (Number.isFinite(ms) && ms > 0) elapsedMs += ms;
    },
    frame: nextFrame,
  };
}

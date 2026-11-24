/**
 * When the driver calls one render finished, stalled or gone, from what the
 * studio's window handle shows each time it is read. Pure: the caller reads
 * the handle and keeps the clock, so every rule here is tested without a page.
 *
 * A render has two stretches. Before the take the studio reads the lesson,
 * loads the speech model and narrates; on a new profile the model download
 * alone takes minutes, and a long lesson narrates hundreds of dialogs. That
 * stretch is judged by progress: it may run long, but its phase must keep
 * changing. The take (preparing the workspace, recording, performing, QA)
 * plays the narration in real time and gets the allowance sized from the
 * lesson's length, counted from the moment it starts.
 */

/**
 * The phases the studio reports from the moment the take begins, as
 * runStudioRender names them. A phase it does not list is part of the
 * stretch before the take.
 */
const TAKE_PHASES: ReadonlySet<string> = new Set([
  "prepare-workspace",
  "prepare-whiteboard",
  "start-recording",
  "perform",
  "finalize",
  "qa",
]);

export function isTakePhase(phase: string): boolean {
  return TAKE_PHASES.has(phase);
}

/**
 * How long one phase before the take may go unchanged. The longest single
 * step there is the first download of the speech model, which took about
 * 8 minutes on a slow home line; the bound leaves room for a slower one.
 */
export const BEFORE_TAKE_STALL_MS = 20 * 60_000;

/** The fixed part of the bound on the whole stretch before the take. */
const BEFORE_TAKE_BASE_MS = 30 * 60_000;

/**
 * How long the whole stretch before the take may take: the model download
 * and set-up, plus narrating, which a slow voice does at a few times the
 * lesson's length.
 */
export function beforeTakeWaitMs(estimatedNarrationMs: number): number {
  return BEFORE_TAKE_BASE_MS + 4 * Math.max(0, estimatedNarrationMs);
}

/**
 * How long the handle may show no render running and no new run after the
 * start was accepted. The studio marks a render running before its first
 * pause, so only a page that reloaded, or a render that ended without a
 * word, shows this for longer.
 */
export const VANISHED_GRACE_MS = 10_000;

export interface RenderWatchLimits {
  /** The take's allowance, from the moment it starts. */
  takeMs: number;
  /** The bound on everything before the take. */
  beforeTakeMs: number;
  /** How long one phase before the take may go unchanged. */
  stallMs: number;
  /** How long the page may show nothing running and no new run. */
  vanishedGraceMs: number;
}

/** What one read of the window handle showed; null fields for a page with no handle. */
export interface RenderObservation {
  now: number;
  /** Runs on the handle; 0 when the page has no handle. */
  runs: number;
  running: boolean;
  /** undefined when the studio does not publish its phase at all. */
  phase: string | null | undefined;
}

export interface RenderWatch {
  readonly limits: RenderWatchLimits;
  /** Runs on the handle when the start was asked for. */
  readonly before: number;
  readonly startedAt: number;
  phase: string | null;
  phaseSince: number;
  /**
   * When the take's allowance began: the start, until a phase says the render
   * is before the take; then null until a take phase shows. A studio that
   * publishes no phase keeps the start, so its whole render has the take's
   * allowance, as it always had.
   */
  takeStartedAt: number | null;
  /** Whether a take phase has shown. */
  inTake: boolean;
  /** The last moment the handle showed a render running or a new run. */
  aliveAt: number;
}

export type RenderWatchVerdict =
  | { kind: "waiting"; phaseChanged: string | null }
  | { kind: "finished" }
  | { kind: "failed"; reason: string };

export function startRenderWatch(
  limits: RenderWatchLimits,
  before: number,
  now: number,
): RenderWatch {
  return {
    limits,
    before,
    startedAt: now,
    phase: null,
    phaseSince: now,
    takeStartedAt: now,
    inTake: false,
    aliveAt: now,
  };
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;
const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** Fold one read of the handle into the watch and say where the render stands. */
export function observeRender(watch: RenderWatch, seen: RenderObservation): RenderWatchVerdict {
  const { limits, before } = watch;
  const { now } = seen;

  if (seen.runs < before) {
    return {
      kind: "failed",
      reason: `the render is gone: the page shows ${seen.runs} runs where it had ${before}, so it was reloaded or replaced`,
    };
  }
  if (seen.runs > before && !seen.running) return { kind: "finished" };

  let phaseChanged: string | null = null;
  if (seen.phase && seen.phase !== watch.phase) {
    phaseChanged = seen.phase;
    watch.phase = seen.phase;
    watch.phaseSince = now;
    if (isTakePhase(seen.phase)) {
      if (!watch.inTake) {
        watch.inTake = true;
        watch.takeStartedAt = now;
      }
    } else if (!watch.inTake) {
      watch.takeStartedAt = null;
    }
  }

  if (seen.running || seen.runs > before) watch.aliveAt = now;
  else if (now - watch.aliveAt > limits.vanishedGraceMs) {
    return {
      kind: "failed",
      reason: `the render is gone: no render has run for ${seconds(now - watch.aliveAt)} and none finished${
        watch.phase ? ` (last phase "${watch.phase}")` : ""
      }; the page was reloaded or the render stopped without saying why`,
    };
  }

  const inPhase = watch.phase ? ` (in phase "${watch.phase}")` : "";
  if (watch.takeStartedAt !== null) {
    if (now - watch.takeStartedAt > limits.takeMs) {
      const counted = watch.inTake ? " of the take" : "";
      return {
        kind: "failed",
        reason: `the render did not finish in ${minutes(limits.takeMs)}${counted}${inPhase}`,
      };
    }
  } else {
    if (now - watch.phaseSince > limits.stallMs) {
      return {
        kind: "failed",
        reason: `the render stalled: no change of phase for ${minutes(now - watch.phaseSince)}, stopped in "${watch.phase}"`,
      };
    }
    if (now - watch.startedAt > limits.beforeTakeMs) {
      return {
        kind: "failed",
        reason: `the render did not reach the take in ${minutes(limits.beforeTakeMs)}${inPhase}`,
      };
    }
  }
  return { kind: "waiting", phaseChanged };
}

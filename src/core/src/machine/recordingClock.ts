// ============================================================================
// The recording clock.
//
// Recorded time is `performance.now()` since the take started, except across
// exclusions: spans where the take was paused. Recorded time stands still
// across an exclusion, so anything captured inside one (an edit made while
// paused, a late preview batch) lands on the instant the clock stopped, and
// the take plays those changes back as one jump instead of silence.
//
// The live preview's rrweb events are stamped with the page's own `Date.now()`
// and placed on the timeline by one constant offset (see
// buildRrwebReplayEvents), so every exclusion is also kept on the wall clock:
// `toRecordingWallTime` removes the same spans from those stamps, and the
// offset stays constant across a pause.
// ============================================================================

export interface RecordingClockExclusion {
  /** `performance.now()` when the clock stopped. */
  startPerf: number;
  /** `performance.now()` when it ran again. */
  endPerf: number;
  /** `Date.now()` at `startPerf`. */
  startWall: number;
  /** `Date.now()` at `endPerf`. */
  endWall: number;
}

export interface RecordingClock {
  /** Closed exclusions, oldest first; they never overlap. */
  exclusions: readonly RecordingClockExclusion[];
  /** Summed length of `exclusions` on the performance clock. */
  excludedPerfMs: number;
  /** Summed length of `exclusions` on the wall clock. */
  excludedWallMs: number;
  /** Where the open exclusion (the current pause) began, or null while recording runs. */
  pausedAt: { perf: number; wall: number } | null;
}

export const createRecordingClock = (): RecordingClock => ({
  exclusions: [],
  excludedPerfMs: 0,
  excludedWallMs: 0,
  pausedAt: null,
});

export function isRecordingClockPaused(clock: RecordingClock): boolean {
  return clock.pausedAt !== null;
}

/**
 * Recorded time at `perf`, a `performance.now()` reading taken during the take.
 * A reading inside an exclusion (or at or after the open pause) maps to the
 * instant the clock stopped.
 */
export function recordingTimeAtPerf(
  clock: RecordingClock,
  startedAtPerf: number,
  perf: number,
): number {
  let excluded = 0;
  for (const exclusion of clock.exclusions) {
    if (perf <= exclusion.startPerf) break;
    if (perf < exclusion.endPerf) {
      return Math.max(0, exclusion.startPerf - startedAtPerf - excluded);
    }
    excluded += exclusion.endPerf - exclusion.startPerf;
  }
  const clampedPerf = clock.pausedAt ? Math.min(perf, clock.pausedAt.perf) : perf;
  return Math.max(0, clampedPerf - startedAtPerf - excluded);
}

/** Recorded time now. */
export function readRecordingClock(
  clock: RecordingClock,
  startedAtPerf: number,
  nowPerf: number = performance.now(),
): number {
  return recordingTimeAtPerf(clock, startedAtPerf, nowPerf);
}

/** Stops the clock at `perf`/`wall`. A paused clock is returned unchanged. */
export function pauseRecordingClock(
  clock: RecordingClock,
  perf: number,
  wall: number,
): RecordingClock {
  if (clock.pausedAt) return clock;
  return { ...clock, pausedAt: { perf, wall } };
}

/**
 * Runs the clock again, closing the open pause as an exclusion. A running clock
 * is returned unchanged. The wall clock is not monotonic, so a pause it reads
 * as negative counts as empty there.
 */
export function resumeRecordingClock(
  clock: RecordingClock,
  perf: number,
  wall: number,
): RecordingClock {
  const pausedAt = clock.pausedAt;
  if (!pausedAt) return clock;

  const exclusion: RecordingClockExclusion = {
    startPerf: pausedAt.perf,
    endPerf: Math.max(perf, pausedAt.perf),
    startWall: pausedAt.wall,
    endWall: Math.max(wall, pausedAt.wall),
  };
  return {
    exclusions: [...clock.exclusions, exclusion],
    excludedPerfMs: clock.excludedPerfMs + (exclusion.endPerf - exclusion.startPerf),
    excludedWallMs: clock.excludedWallMs + (exclusion.endWall - exclusion.startWall),
    pausedAt: null,
  };
}

/**
 * Removes the exclusions from a `Date.now()` stamp taken during the take, so a
 * pause does not open a gap between the wall-clock stamps rrweb puts on preview
 * events and the recorded time they are replayed at. A stamp inside an exclusion
 * maps to the moment the clock stopped.
 */
export function toRecordingWallTime(clock: RecordingClock, wall: number): number {
  let excluded = 0;
  for (const exclusion of clock.exclusions) {
    if (wall <= exclusion.startWall) break;
    if (wall < exclusion.endWall) return exclusion.startWall - excluded;
    excluded += exclusion.endWall - exclusion.startWall;
  }
  if (clock.pausedAt && wall > clock.pausedAt.wall) return clock.pausedAt.wall - excluded;
  return wall - excluded;
}

/** Whether `toRecordingWallTime` can change any stamp: false until the first pause. */
export function hasRecordingClockExclusions(clock: RecordingClock): boolean {
  return clock.exclusions.length > 0 || clock.pausedAt !== null;
}

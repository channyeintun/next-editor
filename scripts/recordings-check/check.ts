/** What one check of one recording found, before it becomes rows of the table. */

import { clip, emptyTally, type Tally } from "./tally.ts";

/** Whether a track's differences break a law, or are reported for a person only. */
export type LawScope = "in law" | "outside";

export interface CheckResult {
  /** The check's name, as the table shows it. */
  check: string;
  /**
   * Per track, in the order the table lists them. A track the recording has no
   * events for is not compared: two empty panels agreeing tells a person nothing.
   */
  tracks: Array<{ track: string; scope: LawScope; tally: Tally; noEvents: boolean }>;
  /**
   * Errors the machine reported while replaying the published recording. Whether
   * the file or the replay code is at fault, the table cannot tell.
   */
  errors: { count: number; first: string | null };
  /** Why the check stopped before the end, when something threw. */
  stopped: string | null;
}

export function createCheck(
  check: string,
  tracks: ReadonlyArray<{ track: string; scope: LawScope }>,
): CheckResult {
  return {
    check,
    tracks: tracks.map(({ track, scope }) => ({
      track,
      scope,
      tally: emptyTally(),
      noEvents: false,
    })),
    errors: { count: 0, first: null },
    stopped: null,
  };
}

function entryOf(result: CheckResult, track: string) {
  const found = result.tracks.find((each) => each.track === track);
  if (!found) throw new Error(`${result.check} has no track ${track}`);
  return found;
}

/** The tally of `track`, which `createCheck` was given. */
export function tallyOf(result: CheckResult, track: string): Tally {
  return entryOf(result, track).tally;
}

/** Marks `track` as one the recording has no events for, so it is shown as such. */
export function markNoEvents(result: CheckResult, track: string): void {
  entryOf(result, track).noEvents = true;
}

/** Whether `track` is compared: the recording has events for it. */
export function isCompared(result: CheckResult, track: string): boolean {
  return !entryOf(result, track).noEvents;
}

/**
 * Counts errors the machine reported while replaying the published recording,
 * moving them out of `errors` so none is counted twice.
 */
export function countErrors(result: CheckResult, errors: string[]): void {
  if (errors.length === 0) return;
  result.errors.count += errors.length;
  result.errors.first ??= errors[0];
  errors.length = 0;
}

/**
 * Counts one replay step of a recording the code under check produced (a cut's
 * output). An error there is the code's output failing to replay, so it is a
 * difference in the law, not a property of the published file.
 */
export function countReplayErrorsAsDifference(
  tally: Tally,
  errors: string[],
  time: number,
  note?: string,
): void {
  tally.checks += 1;
  if (errors.length > 0) {
    tally.diffs += 1;
    tally.first ??= {
      time,
      path: "",
      a: "",
      b: "",
      error: clip(errors[0]),
      ...(note === undefined ? {} : { note }),
    };
  }
  errors.length = 0;
}

/** Runs `body`, and records a throw as the reason the check stopped. */
export function untilStopped(result: CheckResult, body: () => void): CheckResult {
  try {
    body();
  } catch (error) {
    result.stopped = error instanceof Error ? error.message : String(error);
  }
  return result;
}

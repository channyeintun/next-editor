/** What one check of one recording found, before it becomes rows of the table. */

import { emptyTally, type Tally } from "./tally.ts";

/** Whether a track's differences break a law, or are reported for a person only. */
export type LawScope = "in law" | "outside";

export interface CheckResult {
  /** The check's name, as the table shows it. */
  check: string;
  /** Per track, in the order the table lists them. */
  tracks: Array<{ track: string; scope: LawScope; tally: Tally }>;
  /** Errors the recording itself caused (the machine reported a damaged track). */
  odd: { count: number; first: string | null };
  /** Why the check stopped before the end, when something threw. */
  stopped: string | null;
}

export function createCheck(
  check: string,
  tracks: ReadonlyArray<{ track: string; scope: LawScope }>,
): CheckResult {
  return {
    check,
    tracks: tracks.map(({ track, scope }) => ({ track, scope, tally: emptyTally() })),
    odd: { count: 0, first: null },
    stopped: null,
  };
}

/** The tally of `track`, which `createCheck` was given. */
export function tallyOf(result: CheckResult, track: string): Tally {
  const found = result.tracks.find((each) => each.track === track);
  if (!found) throw new Error(`${result.check} has no track ${track}`);
  return found.tally;
}

/** Counts machine-reported errors, moving them out of `errors` so none is counted twice. */
export function countOdd(result: CheckResult, errors: string[]): void {
  if (errors.length === 0) return;
  result.odd.count += errors.length;
  result.odd.first ??= errors[0];
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

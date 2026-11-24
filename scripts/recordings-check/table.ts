/**
 * The table a run prints: one row per recording, check and track, then a line of
 * totals with a short hash of the rows. The hash covers only what the checks found,
 * never how long they took, so a run on main and a run after a change on the same
 * lessons with the same seed hash alike exactly when they found the same.
 */

import { createHash } from "node:crypto";

import type { CheckResult, LawScope } from "./check.ts";
import { roundedMs, type Difference } from "./tally.ts";

/** The track of a row that stands for the whole recording, not one track. */
export const FILE_ROW = "(file)";

export interface Row {
  recording: string;
  check: string;
  track: string;
  scope: LawScope | "";
  checks: number;
  diffs: number;
  /**
   * Errors replaying or decoding the published recording. The table does not say
   * whether the file or the code reading it is at fault: compare with a run on main.
   */
  errors: number;
  /** The first difference, or the first error, or why the check stopped. */
  first: string;
}

/** What the row of a track the recording has no events for says. */
export const NO_EVENTS = "no events";

/** A first difference as one cell: the time, where, and both values cut short. */
export function describeDifference(difference: Difference): string {
  const where = difference.path ? ` ${difference.path}` : "";
  const note = difference.note ? ` (${difference.note})` : "";
  if (difference.error !== undefined) {
    return `t=${roundedMs(difference.time)}: replay error ${difference.error}${note}`;
  }
  return `t=${roundedMs(difference.time)}${where}: ${difference.a} vs ${difference.b}${note}`;
}

/** The rows of one check of one recording. */
export function rowsOf(recording: string, result: CheckResult): Row[] {
  const rows: Row[] = result.tracks.map(({ track, scope, tally, noEvents }) => ({
    recording,
    check: result.check,
    track,
    scope,
    checks: tally.checks,
    diffs: tally.diffs,
    errors: 0,
    first: noEvents ? NO_EVENTS : tally.first ? describeDifference(tally.first) : "",
  }));
  if (result.errors.count > 0 || result.stopped !== null) {
    rows.push({
      recording,
      check: result.check,
      track: FILE_ROW,
      scope: "",
      checks: 0,
      // A check that stopped did not run to the end: a person must look at it.
      diffs: result.stopped === null ? 0 : 1,
      errors: result.errors.count,
      first:
        result.stopped === null ? `error: ${result.errors.first}` : `stopped: ${result.stopped}`,
    });
  }
  return rows;
}

/** The row for a recording the app's decoder could not read. */
export function unreadableRow(recording: string, reason: string): Row {
  return {
    recording,
    check: "decode",
    track: FILE_ROW,
    scope: "",
    checks: 0,
    diffs: 0,
    errors: 1,
    first: `error: ${reason}`,
  };
}

const HEADER: Row = {
  recording: "recording",
  check: "check",
  track: "track",
  scope: "law" as LawScope,
  checks: 0,
  diffs: 0,
  errors: 0,
  first: "first difference",
};

/** The longest a recording's name may be in its column. */
const RECORDING_WIDTH = 32;

const cut = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

function cells(row: Row, header: boolean): string[] {
  return [
    cut(row.recording, RECORDING_WIDTH),
    row.check,
    row.track,
    row.scope,
    header ? "checks" : String(row.checks),
    header ? "diffs" : String(row.diffs),
    header ? "errors" : String(row.errors),
    row.first,
  ];
}

/** The rows as aligned text, with a header line. */
export function formatTable(rows: readonly Row[]): string {
  const lines = [cells(HEADER, true), ...rows.map((row) => cells(row, false))];
  const widths = lines[0].map((_, column) => Math.max(...lines.map((line) => line[column].length)));
  const numeric = new Set([4, 5, 6]);
  return lines
    .map((line) =>
      line
        .map((cell, column) => {
          if (column === line.length - 1) return cell;
          return numeric.has(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column]);
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** A short hash of the rows: equal for runs that found the same. */
export function tableHash(rows: readonly Row[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(
      JSON.stringify([
        row.recording,
        row.check,
        row.track,
        row.scope,
        row.checks,
        row.diffs,
        row.errors,
        row.first,
      ]),
    );
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 12);
}

/** The last line: totals, split by whether the law covers them, and the hash. */
export function totalsLine(rows: readonly Row[]): string {
  const sum = (pick: (row: Row) => number, keep: (row: Row) => boolean = () => true) =>
    rows.filter(keep).reduce((total, row) => total + pick(row), 0);
  const recordings = new Set(rows.map((row) => row.recording)).size;
  const inLaw = sum(
    (row) => row.diffs,
    (row) => row.scope !== "outside",
  );
  const outside = sum(
    (row) => row.diffs,
    (row) => row.scope === "outside",
  );
  return [
    `total: ${recordings} recordings`,
    `${sum((row) => row.checks)} checks`,
    `${inLaw} differences in law`,
    `${outside} outside the law`,
    `${sum((row) => row.errors)} errors`,
    `hash ${tableHash(rows)}`,
  ].join(", ");
}

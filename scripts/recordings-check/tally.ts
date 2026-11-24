/**
 * Counting, per track, how many times two sides were compared and how often they
 * differed, keeping the first difference to show a person.
 */

import { createHash } from "node:crypto";

/** How long one side of a difference may be in the table. */
export const VALUE_WIDTH = 70;

export interface Difference {
  /** The recording time the two sides were compared at, in ms. */
  time: number;
  /** Where in the shown value they first part, keys joined by "." ("" for the whole). */
  path: string;
  /** The first side's value at that path, cut short. */
  a: string;
  /** The second side's value at that path, cut short. */
  b: string;
  /** What else a person needs to see it again (the cut, for the cut law). */
  note?: string;
  /** The error a replay reported, when the difference is that it failed. */
  error?: string;
}

export interface Tally {
  checks: number;
  diffs: number;
  first: Difference | null;
}

export const emptyTally = (): Tally => ({ checks: 0, diffs: 0, first: null });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Keys whose value is not undefined. Replay builds the same state by different
 * paths, and one may spell "not set" as a missing key and the other as undefined;
 * a viewer sees no difference between the two.
 */
const definedKeys = (value: Record<string, unknown>) =>
  Object.keys(value).filter((key) => value[key] !== undefined);

/**
 * The keys to the first place `a` and `b` differ, or null when they are equal. Key
 * order does not matter; array order does. Keys stay separate because file paths,
 * which key a project's files, hold dots.
 */
export function firstDifferencePath(a: unknown, b: unknown): string[] | null {
  if (Object.is(a, b)) return null;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return [];
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return ["length"];
  const keys = new Set([...definedKeys(a), ...definedKeys(b)]);
  for (const key of keys) {
    const inner = firstDifferencePath(a[key], b[key]);
    if (inner !== null) return [key, ...inner];
  }
  return null;
}

/** A time to read back: recorded stamps carry float noise past the microsecond. */
export const roundedMs = (time: number) => Number(time.toFixed(3));

/** `value` as one line of JSON, cut short to `width`. */
export function clip(value: unknown, width = VALUE_WIDTH): string {
  const text = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/** The value at keys made by firstDifferencePath. */
function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = key === "length" && Array.isArray(current) ? current.length : current[key];
  }
  return current;
}

/** Where `a` and `b` first part at `time`, or null when they are equal. */
export function differenceAt(
  time: number,
  a: unknown,
  b: unknown,
  note?: string,
): Difference | null {
  const path = firstDifferencePath(a, b);
  if (path === null) return null;
  return {
    time,
    path: path.join("."),
    a: clip(at(a, path)),
    b: clip(at(b, path)),
    ...(note === undefined ? {} : { note }),
  };
}

/** Counts one comparison of `a` and `b` at `time`. */
export function compare(tally: Tally, time: number, a: unknown, b: unknown, note?: string): void {
  tally.checks += 1;
  const difference = differenceAt(time, a, b, note);
  if (difference === null) return;
  tally.diffs += 1;
  tally.first ??= difference;
}

/**
 * `value` as text that is equal for two values exactly when firstDifferencePath finds
 * them equal: key order and keys holding undefined do not count, array order and
 * length do, and numbers keep what Object.is tells apart (-0, NaN).
 */
export function stableText(value: unknown): string {
  if (isObject(value)) {
    const keys = definedKeys(value).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`);
    return Array.isArray(value)
      ? `[${value.length}|${entries.join(",")}]`
      : `{${entries.join(",")}}`;
  }
  if (typeof value === "number") return Object.is(value, -0) ? "n-0" : `n${value}`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `b${value}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * A short digest of `value` under stableText. A walk keeps one per time instead of a
 * copy of every panel, which for a long lesson with many files is gigabytes.
 */
export function digestOf(value: unknown): string {
  return createHash("sha1").update(stableText(value)).digest("base64");
}

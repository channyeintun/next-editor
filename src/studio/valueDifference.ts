/**
 * Where two plain-data values first differ: the one deep comparison the studio's
 * checks and the hand-run recording checks share, so "equal" means the same in
 * both.
 *
 * It treats a value the way the recording file stores it, which is also how a
 * viewer sees it: a key holding undefined is no key (the encoder skips it, and
 * replay may spell "not set" either way), an undefined array item is null, NaN
 * equals NaN, and binary data is compared byte by byte.
 */

/** Keys from the root down to where the values part: a number is an array index or a byte offset. */
export type ValuePath = readonly (string | number)[];

export type ValueDifference =
  /** Two values that differ at `path`. */
  | { kind: "value"; path: ValuePath; left: unknown; right: unknown }
  /** Two arrays (`unit` "items") or two binary values (`unit` "bytes") of different lengths. */
  | { kind: "length"; unit: "items" | "bytes"; path: ValuePath; left: number; right: number }
  /** Two binary values of one length whose bytes first differ at `offset`. */
  | { kind: "bytes"; path: ValuePath; offset: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

function differenceAt(
  left: unknown,
  right: unknown,
  path: (string | number)[],
): ValueDifference | null {
  if (left === right) return null;
  if (Number.isNaN(left) && Number.isNaN(right)) return null;
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    if (leftBytes.length !== rightBytes.length) {
      return {
        kind: "length",
        unit: "bytes",
        path: [...path],
        left: leftBytes.length,
        right: rightBytes.length,
      };
    }
    const offset = leftBytes.findIndex((byte, index) => byte !== rightBytes[index]);
    return offset === -1 ? null : { kind: "bytes", path: [...path], offset };
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return {
        kind: "length",
        unit: "items",
        path: [...path],
        left: left.length,
        right: right.length,
      };
    }
    for (let index = 0; index < left.length; index++) {
      path.push(index);
      const difference = differenceAt(left[index] ?? null, right[index] ?? null, path);
      path.pop();
      if (difference) return difference;
    }
    return null;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      path.push(key);
      const difference = differenceAt(left[key], right[key], path);
      path.pop();
      if (difference) return difference;
    }
    return null;
  }
  return { kind: "value", path: [...path], left, right };
}

/** The first place `left` and `right` differ, or null when they are equal. */
export function firstValueDifference(left: unknown, right: unknown): ValueDifference | null {
  return differenceAt(left, right, []);
}

/** A path as code would write it from `root`: `root.key[0].other`. */
export function formatValuePath(root: string, path: ValuePath): string {
  return path.reduce<string>(
    (text, key) => (typeof key === "number" ? `${text}[${key}]` : `${text}.${key}`),
    root,
  );
}

// A large ES module's prepared form (transform.ts) as a file. Rewriting a
// module of megabytes takes a third of a second and, far worse, some 50 MB of
// heap at once, which the browser never gives back to the system once a
// worker has used it. So the kernel rewrites such a file once
// (kernel/preparedModules.ts), keeps the result here, and the editor's page
// keeps it between visits (preparedStorage.ts); a process reads the entry
// instead of rewriting the file itself (loader/prepared.ts).
//
// This module is the one both sides share: which files get an entry, where
// entries live, how one is laid out, and which rewrite made it.
import type { PreparedSource } from "./transform";

declare const __WEBNODE_TRANSFORM_ID__: string | undefined;

/** The layout of an entry; a change of it makes every kept entry another version's. */
const ENTRY_LAYOUT = 1;

/**
 * The version of the entries this build makes and reads: the layout, and the
 * rewrite that makes them (build/webnodeBundle.ts names it from the rewrite's
 * own source). "" where the build names none (unit tests): nothing is kept
 * between visits then.
 */
export const PREPARED_VERSION: string =
  typeof __WEBNODE_TRANSFORM_ID__ === "string" && __WEBNODE_TRANSFORM_ID__ !== ""
    ? `${ENTRY_LAYOUT}.${__WEBNODE_TRANSFORM_ID__}`
    : "";

/** Where the kernel puts the entries of a session, each under its key. */
export const PREPARED_DIR = "/var/cache/webnode/prepared";

/** The smallest source that gets an entry: below it the rewrite costs less than the asking. */
export const PREPARED_MIN_BYTES = 128 * 1024;

/**
 * Whether ES module file `filename` of `size` bytes gets an entry: a large
 * file of an installed package. A project's own files change as they are
 * typed, and are small.
 */
export function isPreparable(filename: string, size: number): boolean {
  return size >= PREPARED_MIN_BYTES && filename.includes("/node_modules/");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NEWLINE = 10;

/** `prepared` as an entry: one line of JSON for all but its code, then the code. */
export function encodePreparedEntry(prepared: PreparedSource): Uint8Array {
  const { code, ...rest } = prepared;
  const head = encoder.encode(`${JSON.stringify(rest)}\n`);
  const body = encoder.encode(code);
  const entry = new Uint8Array(head.length + body.length);
  entry.set(head);
  entry.set(body, head.length);
  return entry;
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The prepared module `entry` holds; null for bytes that are no entry of an ES module. */
export function decodePreparedEntry(entry: Uint8Array): PreparedSource | null {
  const end = entry.indexOf(NEWLINE);
  if (end < 0) {
    return null;
  }
  let head: Partial<Omit<PreparedSource, "code">> | null;
  try {
    head = JSON.parse(decoder.decode(entry.subarray(0, end))) as typeof head;
  } catch {
    return null;
  }
  if (head === null || typeof head !== "object") {
    return null;
  }
  const { format, specifiers, prologue, exportNames, starExports, importedNames } = head;
  if (
    format !== "esm" ||
    !isStrings(specifiers) ||
    typeof prologue !== "string" ||
    !(exportNames === null || isStrings(exportNames)) ||
    !isStrings(starExports) ||
    !Array.isArray(importedNames) ||
    !importedNames.every((one) => typeof one?.specifier === "string" && isStrings(one.names))
  ) {
    return null;
  }
  return {
    format,
    code: decoder.decode(entry.subarray(end + 1)),
    specifiers,
    prologue,
    exportNames,
    starExports,
    importedNames,
  };
}

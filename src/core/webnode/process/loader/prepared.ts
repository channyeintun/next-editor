// A process's way to a large module's prepared form without rewriting the
// file itself: it asks the kernel where the entry is and reads it
// (preparedEntry.ts says what gets one, kernel/preparedModules.ts makes them).
import { runtime } from "../runtime";
import { decodePreparedEntry, isPreparable } from "./preparedEntry";
import type { PreparedSource } from "./transform";

/**
 * The prepared form of ES module file `filename`, from the kernel's entry for
 * it. Null when the file gets none, the kernel has none to offer (it could
 * not read or rewrite the file), or the entry cannot be read: the caller then
 * prepares the file itself, and reports what is wrong with it.
 */
export function preparedFromStore(filename: string): PreparedSource | null {
  const { fs, prepared } = runtime();
  try {
    if (!isPreparable(filename, fs.stat(filename, true).size)) {
      return null;
    }
    const entry = prepared.locate(filename);
    return entry === null ? null : decodePreparedEntry(fs.readFile(entry));
  } catch {
    return null;
  }
}

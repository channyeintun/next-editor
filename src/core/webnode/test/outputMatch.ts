// Finding a pattern in what a process printed. The harness page searches with
// it (test/harnessPage.ts), and a scenario's terminal (test/scenario.ts) reads
// what it answers.

/** Where a pattern matched in a process's output, as offsets into all it printed. */
export interface OutputMatch {
  start: number;
  end: number;
  /** The pattern's capture groups, null for one that took no part. */
  groups: (string | null)[];
}

/**
 * The first match of `pattern` in `output` from offset `from` on. `^` in the
 * pattern is that offset: nothing printed before it takes part.
 */
export function findInOutput(output: string, pattern: string, from: number): OutputMatch | null {
  const found = new RegExp(pattern).exec(output.slice(from));
  if (!found) {
    return null;
  }
  const start = from + found.index;
  return {
    start,
    end: start + found[0].length,
    groups: found.slice(1).map((group) => group ?? null),
  };
}

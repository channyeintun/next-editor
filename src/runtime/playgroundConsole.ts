/**
 * The pieces every `runtime/<lang>Playground/console.ts` builds its lines
 * from. The message tables stay in each language's module, spelled out in
 * full, so a line seen in the console can be found by searching for it.
 */

/**
 * A program's output as console lines, without its trailing newlines.
 *
 * Trimmed with an index walk rather than `/\n+$/`: an unanchored greedy run is
 * retried from every newline in the run, so a program that prints thousands of
 * blank lines followed by anything else freezes the tab for seconds. The
 * assembly machine runs in the page with a 256 KiB output budget, so one buggy
 * loop that prints a blank line per iteration and then a summary hands this a
 * quarter of a million newlines.
 */
export function splitOutputLines(output: string): string[] {
  let end = output.length;
  while (end > 0 && output.charCodeAt(end - 1) === 10) {
    end -= 1;
  }
  const trimmed = output.slice(0, end);
  return trimmed ? trimmed.split("\n") : [];
}

/** File paths for a console line: up to four in full, otherwise three and a count. */
export function summarizeFilePaths(filePaths: readonly string[]): string {
  return filePaths.length <= 4
    ? filePaths.join(" ")
    : `${filePaths.slice(0, 3).join(" ")} … (${filePaths.length} files)`;
}

/**
 * A service error as console lines: the kind's line from a language's table,
 * followed by the service's own detail when it refused the program — the one
 * failure whose detail tells the learner what to change.
 */
export function serviceErrorConsoleLines<Kind extends string>(
  lines: Readonly<Record<Kind, string>>,
  kind: Kind,
  detail?: string,
): string[] {
  const consoleLines = [lines[kind]];
  if (kind === "invalid-source" && detail) {
    consoleLines.push(detail);
  }
  return consoleLines;
}

import type { PlaygroundFile } from "../playgroundContract";
import { serviceErrorConsoleLines, splitOutputLines } from "../playgroundConsole";
import { PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { PythonPlaygroundServiceErrorKind } from "./client";
import { findPythonRunEntry } from "./files";
import type { PythonPlaygroundRunResult } from "./types";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape recordings capture and playback replays — no
 * detail of how the interpreter is hosted leaks into the recorded lines.
 *
 * The service-error table is three entries rather than five because a Python
 * lesson has no service to be throttled by, switched off at, or cut off from.
 */

/**
 * The tags this module emits, as the pattern the runner panel colours by. It
 * lives beside the builders rather than in the panel so the two are read
 * together: a tag added here without the pattern silently loses its colour, and
 * a pattern loose enough to match any `[...]` head paints a program's own
 * bracketed line — a printed list, which Python prints all the time — as if the
 * runner had said it.
 */
export const PYTHON_CONSOLE_TAG_PATTERN = /^\[python-run(?: error)?\]/;

/**
 * The command a person would type to do the same thing: `python` and the
 * script the run starts from. A workspace the client will refuse (no script,
 * or several and none named `main.py`) still gets a started line, naming the
 * script it was looking for.
 */
export function pythonRunStartedConsoleLines(files: readonly PlaygroundFile[]): string[] {
  const entry = findPythonRunEntry(files);
  const path = typeof entry === "string" ? PLAYGROUND_SOURCE_RULES.python.entryPath : entry.path;
  return [`[python-run] python ${path}`];
}

export function pythonRunResultToConsoleLines(result: PythonPlaygroundRunResult): string[] {
  // The output can be 256 KiB of one-character lines, more than a spread call
  // takes as arguments, so the lines are pushed onto the split array itself.
  const outputLines = splitOutputLines(result.output);
  const lines: string[] = outputLines.length > 0 ? outputLines : ["[python-run] (no output)"];

  if (result.status === "success") {
    lines.push("[python-run] Program exited");
    return lines;
  }

  // The hint sits between the traceback it explains and the exit line.
  if (result.hint) lines.push(`[python-run] ${result.hint}`);
  lines.push(
    result.exitDetail
      ? `[python-run error] ${result.exitDetail}`
      : `[python-run error] Program exited with status ${result.exitCode ?? 1}`,
  );
  return lines;
}

const SERVICE_ERROR_LINES: Record<Exclude<PythonPlaygroundServiceErrorKind, "aborted">, string> = {
  "invalid-source": "[python-run error] This program can't run in a Python lesson",
  unavailable:
    "[python-run error] Python could not be loaded — your code is unchanged, try again shortly",
  // Trying again cannot work here, so the line must not say to.
  outdated:
    "[python-run error] This page is older than the app's latest version, so Python cannot start — save your work, then reload the page",
};

export function pythonRunServiceErrorToConsoleLines(
  kind: Exclude<PythonPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  return serviceErrorConsoleLines(SERVICE_ERROR_LINES, kind, detail);
}

/**
 * Contracts for the Python runner.
 *
 * Like Kite and assembly and unlike Go, Kotlin, Rust, Zig and Haskell, **there
 * is no service.** The interpreter is CPython itself, built to WebAssembly
 * (Pyodide), and it runs in a worker of this page: no proxy, no rate limit, and
 * no lesson that stops working because a public playground went down. What that
 * removes from this file is the throttling and outage vocabulary the proxied
 * languages have to model.
 *
 * The result is one `output` rather than a stdout and a stderr, as Go's and
 * Zig's are. A Python program's two streams interleave — a `print`, a
 * `logging.warning`, another `print`, then a traceback — and a terminal shows
 * them in the order they were written. Two fields would lose that order, and a
 * fixture pinned in two fields would replay a console no live run produces.
 *
 * For the same reason the lines a program read are in `output` too, each where
 * a terminal echoes it: after the prompt, on the prompt's line. `output` is the
 * session as it was on screen, so a pinned result replays the console of a run
 * that asked for input with no keyboard anywhere.
 */

import { isOptionalString, type PlaygroundFile } from "../playgroundContract";

export type PythonPlaygroundRunStatus = "success" | "runtime-error";

/** A text file of the lesson workspace, at its workspace path. */
export type PythonPlaygroundFile = PlaygroundFile;

export interface PythonPlaygroundRunRequest {
  files: readonly PythonPlaygroundFile[];
}

export interface PythonPlaygroundRunResult {
  status: PythonPlaygroundRunStatus;
  /**
   * Everything the program wrote, standard output and standard error in the
   * order written, with each line it read echoed where it was typed. An
   * uncaught exception's traceback is part of it, exactly as `python main.py`
   * prints one.
   */
  output: string;
  /**
   * The lines the program read from standard input, in order and without their
   * line breaks. Absent when it read none. `output` shows each of them already;
   * they are kept apart as well because they are what the run was given, so a
   * pinned result says what to type to get this run again.
   */
  stdin?: string[];
  /**
   * The status Python exited with. Absent or 0 for "success"; for
   * "runtime-error" it is the non-zero status of an uncaught exception (1) or
   * of `sys.exit(n)`, and absent when the runner stopped the program instead.
   */
  exitCode?: number;
  /**
   * What stopped the program when Python did not exit by itself: too much
   * output, or an interpreter that died. Present only with "runtime-error",
   * and never together with `exitCode`.
   */
  exitDetail?: string;
  /**
   * One line for the learner about a failure this runner, not the program,
   * explains: `input()` that found the end of its input, or an import of a
   * package that is not here. Present only with a "runtime-error" that has an
   * `exitCode`, since the traceback it explains is Python's own.
   */
  hint?: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "runtime-error"]);

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
}

/** One line of input: a string with no line break in it. */
function isInputLine(value: unknown): value is string {
  return typeof value === "string" && !/[\r\n]/.test(value);
}

/**
 * Whether `output` echoes every line of `stdin`, in order: each line is
 * followed by a line break somewhere after the one before it. It is what a run
 * always produces, and what a result edited by hand — a line changed in one
 * field and not the other — no longer does.
 */
function echoesInOrder(output: string, stdin: readonly string[]): boolean {
  let from = 0;
  for (const line of stdin) {
    const at = output.indexOf(`${line}\n`, from);
    if (at === -1) return false;
    from = at + line.length + 1;
  }
  return true;
}

/**
 * Validate a run result, or null when the payload does not match the contract.
 *
 * The interpreter is in this page rather than across a network, but the check
 * stays for the same reason Kite's does: a status that disagrees with its own
 * exit would render a clean run for an impossible state, and the studio pins
 * results by hand, where that mistake is easy to write.
 */
export function parsePythonPlaygroundRunResult(value: unknown): PythonPlaygroundRunResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status) ||
    typeof candidate.output !== "string" ||
    !(candidate.stdin === undefined || Array.isArray(candidate.stdin)) ||
    !isOptionalInteger(candidate.exitCode) ||
    !isOptionalString(candidate.exitDetail) ||
    !isOptionalString(candidate.hint)
  ) {
    return null;
  }

  const status = candidate.status as PythonPlaygroundRunStatus;
  const { exitCode, exitDetail, hint } = candidate;
  const hasExitDetail = typeof exitDetail === "string" && exitDetail.trim().length > 0;

  if (status === "success") {
    if (exitDetail !== undefined || (exitCode !== undefined && exitCode !== 0)) return null;
  } else if (hasExitDetail ? exitCode !== undefined : exitDetail !== undefined || !exitCode) {
    // A failed run ended one of two ways, never both and never neither: Python
    // exited with a non-zero status, or the runner stopped it and says why.
    return null;
  }
  // A hint explains a traceback, so it needs the run that printed one.
  if (hint !== undefined && (hint.trim().length === 0 || !exitCode)) return null;
  // A run that read nothing has no `stdin`, so an empty list is no run's result.
  const stdin = candidate.stdin as unknown[] | undefined;
  if (stdin !== undefined) {
    if (stdin.length === 0 || !stdin.every(isInputLine)) return null;
    // A runner that stopped the program cut the output, perhaps before an echo.
    if (!hasExitDetail && !echoesInOrder(candidate.output, stdin)) return null;
  }

  const result: PythonPlaygroundRunResult = { status, output: candidate.output };
  if (stdin !== undefined) result.stdin = stdin;
  if (exitCode !== undefined) result.exitCode = exitCode;
  if (exitDetail !== undefined) result.exitDetail = exitDetail;
  if (hint !== undefined) result.hint = hint;
  return result;
}

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
   * order written. An uncaught exception's traceback is part of it, exactly as
   * `python main.py` prints one.
   */
  output: string;
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
   * explains: `input()` with no keyboard to read, or an import of a package
   * that is not here. Present only with a "runtime-error" that has an
   * `exitCode`, since the traceback it explains is Python's own.
   */
  hint?: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "runtime-error"]);

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
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

  const result: PythonPlaygroundRunResult = { status, output: candidate.output };
  if (exitCode !== undefined) result.exitCode = exitCode;
  if (exitDetail !== undefined) result.exitDetail = exitDetail;
  if (hint !== undefined) result.hint = hint;
  return result;
}

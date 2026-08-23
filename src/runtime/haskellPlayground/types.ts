/**
 * First-party contracts between the browser Haskell Playground client and the
 * main Worker's /api/haskell-playground/run proxy route. Upstream response
 * shapes never cross this boundary — the Worker normalizes them into the
 * result types below, mirroring the Go, Kotlin, Rust, and Zig Playground
 * contracts.
 *
 * There is no format request here: play.haskell.org exposes no formatter
 * endpoint, so the Haskell path is run-only like Kotlin's.
 *
 * The shape follows Rust's real stdout/stderr split rather than Zig's single
 * merged `output`, plus Kotlin's separate `warnings` channel, because upstream
 * genuinely answers with three streams: `sout` and `serr` are the program's
 * own, and `ghcout` is GHC's diagnostics. Zig's contract carries one field to
 * avoid inventing a division the service never made; collapsing these three
 * would be the mirror-image mistake — erasing a division the service really
 * did make. It matters most for `ghcout`: a program that compiled still gets
 * warnings there, and folding them into stderr would make GHC's advice look
 * like something the program printed.
 */

export type HaskellPlaygroundRunStatus = "success" | "compile-error" | "runtime-error";

export interface HaskellPlaygroundFile {
  /** Top-level `.hs` path in the lesson workspace; the Playground runs exactly one `Main.hs`. */
  path: string;
  content: string;
}

export interface HaskellPlaygroundRunRequest {
  files: readonly HaskellPlaygroundFile[];
}

export interface HaskellPlaygroundRunResult {
  status: HaskellPlaygroundRunStatus;
  /** Program stdout. Empty for compile errors — nothing ran. */
  stdout: string;
  /**
   * Program stderr, including the uncaught-exception report GHC's runtime
   * prints when the program dies (e.g. "Main: Prelude.head: empty list").
   * Empty for compile errors — their diagnostics live in compileErrors.
   */
  stderr: string;
  /** GHC error diagnostics; present exactly when status is "compile-error". */
  compileErrors?: string;
  /**
   * GHC warning diagnostics from a program that did compile, rendered
   * separately from program output. Optional on "success" and
   * "runtime-error"; never set for "compile-error", where the whole of GHC's
   * output is the error text.
   */
  warnings?: string;
  /** Upstream exit summary (e.g. "Exited with status 1"); present exactly when status is "runtime-error". */
  exitDetail?: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "compile-error", "runtime-error"]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Validate a decoded Worker response into a run result, or null when the
 * payload does not match the contract. Unknown extra fields are dropped so
 * upstream additions can never leak into app state — that includes upstream's
 * `timesecs`, which the runner has no use for.
 */
export function parseHaskellPlaygroundRunResult(value: unknown): HaskellPlaygroundRunResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status) ||
    typeof candidate.stdout !== "string" ||
    typeof candidate.stderr !== "string" ||
    !isOptionalString(candidate.compileErrors) ||
    !isOptionalString(candidate.warnings) ||
    !isOptionalString(candidate.exitDetail)
  ) {
    return null;
  }

  const status = candidate.status as HaskellPlaygroundRunStatus;
  const hasCompileErrors =
    typeof candidate.compileErrors === "string" && candidate.compileErrors.trim().length > 0;
  const hasExitDetail =
    typeof candidate.exitDetail === "string" && candidate.exitDetail.trim().length > 0;

  // Keep the response a real discriminated contract even though diagnostics
  // are optional at the TypeScript surface. This prevents malformed Worker or
  // cache data from rendering a successful run for an impossible status.
  if (
    (status === "success" &&
      (candidate.compileErrors !== undefined || candidate.exitDetail !== undefined)) ||
    // A compile error means the program never ran, so it can carry neither
    // stream, and GHC's whole output is the error rather than a warning.
    (status === "compile-error" &&
      (!hasCompileErrors ||
        candidate.exitDetail !== undefined ||
        candidate.warnings !== undefined ||
        candidate.stdout !== "" ||
        candidate.stderr !== "")) ||
    (status === "runtime-error" && (!hasExitDetail || candidate.compileErrors !== undefined)) ||
    (candidate.warnings !== undefined && candidate.warnings.trim().length === 0)
  ) {
    return null;
  }

  const result: HaskellPlaygroundRunResult = {
    status,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
  };

  if (candidate.compileErrors !== undefined) result.compileErrors = candidate.compileErrors;
  if (candidate.warnings !== undefined) result.warnings = candidate.warnings;
  if (candidate.exitDetail !== undefined) result.exitDetail = candidate.exitDetail;

  return result;
}

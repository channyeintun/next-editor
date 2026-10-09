/**
 * First-party contracts between the browser Zig Playground client and the
 * main Worker's /api/zig-playground/{run,format} proxy routes. Upstream
 * response shapes never cross this boundary — the Worker normalizes them into
 * the result types below, mirroring the Go, Kotlin, and Rust Playground
 * contracts.
 *
 * One shape difference from the others is forced by the upstream: zig-play.dev
 * runs the program with its streams merged and answers with a single
 * `text/plain` body, so there is no honest stdout/stderr split to expose. This
 * contract carries one `output` field instead of inventing a division the
 * service never made — and it matters more in Zig than elsewhere, because the
 * first thing every Zig program uses, `std.debug.print`, writes to stderr.
 */

import {
  isOptionalString,
  parsePlaygroundFormatResult,
  type PlaygroundFile,
  type PlaygroundFilesRequest,
  type PlaygroundFormatResult,
} from "../playgroundContract";

export type ZigPlaygroundRunStatus = "success" | "compile-error" | "runtime-error";

/** A source file at a top-level `.zig` path in the lesson workspace; the Playground runs exactly one `main.zig`. */
export type ZigPlaygroundFile = PlaygroundFile;

export type ZigPlaygroundRunRequest = PlaygroundFilesRequest;

export type ZigPlaygroundFormatRequest = PlaygroundFilesRequest;

export type ZigPlaygroundFormatResult = PlaygroundFormatResult;

export interface ZigPlaygroundRunResult {
  status: ZigPlaygroundRunStatus;
  /**
   * The program's merged stdout and stderr. For a runtime error this also
   * carries the panic message and stack trace that follow the output, because
   * that trace is the part a learner needs to read. Empty for compile errors —
   * their diagnostics live in compileErrors.
   */
  output: string;
  /** Compiler diagnostics; present exactly when status is "compile-error". */
  compileErrors?: string;
  /** One-line failure summary (e.g. "panic: integer overflow"); present exactly when status is "runtime-error". */
  exitDetail?: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "compile-error", "runtime-error"]);

/** Validate the Worker's normalized `zig fmt` response. */
export const parseZigPlaygroundFormatResult = parsePlaygroundFormatResult;

/**
 * Validate a decoded Worker response into a run result, or null when the
 * payload does not match the contract. Unknown extra fields are dropped so
 * upstream additions can never leak into app state.
 */
export function parseZigPlaygroundRunResult(value: unknown): ZigPlaygroundRunResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status) ||
    typeof candidate.output !== "string" ||
    !isOptionalString(candidate.compileErrors) ||
    !isOptionalString(candidate.exitDetail)
  ) {
    return null;
  }

  const status = candidate.status as ZigPlaygroundRunStatus;
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
    (status === "compile-error" &&
      (!hasCompileErrors || candidate.exitDetail !== undefined || candidate.output !== "")) ||
    (status === "runtime-error" && (!hasExitDetail || candidate.compileErrors !== undefined))
  ) {
    return null;
  }

  const result: ZigPlaygroundRunResult = {
    status,
    output: candidate.output,
  };

  if (candidate.compileErrors !== undefined) result.compileErrors = candidate.compileErrors;
  if (candidate.exitDetail !== undefined) result.exitDetail = candidate.exitDetail;

  return result;
}

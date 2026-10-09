/**
 * First-party contracts between the browser Go Playground client and the main
 * Worker's /api/go-playground/{run,format} proxy routes. Upstream response
 * shapes never cross this boundary — the Worker normalizes them into the
 * result types below (docs/go-lessons-selective-runtime-plan.md §7).
 */

import {
  isOptionalString,
  parsePlaygroundFormatResult,
  type PlaygroundFile,
  type PlaygroundFilesRequest,
  type PlaygroundFormatResult,
} from "../playgroundContract";

export type GoPlaygroundRunStatus = "success" | "compile-error" | "vet-error" | "runtime-error";

/** A source file at a top-level `.go` path in the lesson workspace. */
export type GoPlaygroundFile = PlaygroundFile;

export type GoPlaygroundRunRequest = PlaygroundFilesRequest;

export type GoPlaygroundFormatRequest = PlaygroundFilesRequest;

export type GoPlaygroundFormatResult = PlaygroundFormatResult;

export interface GoPlaygroundRunResult {
  status: GoPlaygroundRunStatus;
  /** Program stdout/stderr event messages concatenated in upstream order. */
  output: string;
  /** Compiler diagnostics; present exactly when status is "compile-error". */
  compileErrors?: string;
  /** Vet diagnostics; rendered separately from program output. */
  vetErrors?: string;
  exitCode?: number;
  /** Preserved for future visible-test support; unused by the v1 UI. */
  isTest?: boolean;
  testsFailed?: number;
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "compile-error",
  "vet-error",
  "runtime-error",
]);

function isOptionalInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

/** Validate the Worker's normalized multi-file gofmt response. */
export const parseGoPlaygroundFormatResult = parsePlaygroundFormatResult;

/**
 * Validate a decoded Worker response into a run result, or null when the
 * payload does not match the contract. Unknown extra fields are dropped so
 * upstream additions can never leak into app state.
 */
export function parseGoPlaygroundRunResult(value: unknown): GoPlaygroundRunResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status) ||
    typeof candidate.output !== "string" ||
    !isOptionalString(candidate.compileErrors) ||
    !isOptionalString(candidate.vetErrors) ||
    !isOptionalInteger(candidate.exitCode) ||
    (candidate.isTest !== undefined && typeof candidate.isTest !== "boolean") ||
    !isOptionalInteger(candidate.testsFailed)
  ) {
    return null;
  }

  const status = candidate.status as GoPlaygroundRunStatus;
  const hasCompileErrors =
    typeof candidate.compileErrors === "string" && candidate.compileErrors.trim().length > 0;
  const hasVetErrors =
    typeof candidate.vetErrors === "string" && candidate.vetErrors.trim().length > 0;

  // Keep the response a real discriminated contract even though diagnostics
  // are optional at the TypeScript surface. This prevents malformed Worker or
  // cache data from rendering a successful exit for an impossible status.
  if (
    (status === "success" &&
      (candidate.exitCode !== 0 ||
        candidate.compileErrors !== undefined ||
        candidate.vetErrors !== undefined)) ||
    (status === "compile-error" &&
      (!hasCompileErrors ||
        candidate.vetErrors !== undefined ||
        candidate.exitCode !== undefined)) ||
    (status === "vet-error" &&
      (!hasVetErrors || candidate.compileErrors !== undefined || candidate.exitCode !== 0)) ||
    (status === "runtime-error" &&
      (candidate.compileErrors !== undefined ||
        candidate.exitCode === undefined ||
        candidate.exitCode === 0 ||
        (candidate.vetErrors !== undefined && !hasVetErrors)))
  ) {
    return null;
  }

  const result: GoPlaygroundRunResult = {
    status,
    output: candidate.output,
  };

  if (candidate.compileErrors !== undefined) result.compileErrors = candidate.compileErrors;
  if (candidate.vetErrors !== undefined) result.vetErrors = candidate.vetErrors;
  if (candidate.exitCode !== undefined) result.exitCode = candidate.exitCode;
  if (candidate.isTest !== undefined) result.isTest = candidate.isTest;
  if (candidate.testsFailed !== undefined) result.testsFailed = candidate.testsFailed;

  return result;
}

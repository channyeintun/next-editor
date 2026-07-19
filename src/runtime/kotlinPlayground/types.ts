/**
 * First-party contracts between the browser Kotlin Playground client and the
 * main Worker's /api/kotlin-playground/run proxy route. Upstream response
 * shapes never cross this boundary — the Worker normalizes them into the
 * result types below, mirroring the Go Playground contract in
 * ../goPlayground/types.ts.
 */

export type KotlinPlaygroundRunStatus = "success" | "compile-error" | "runtime-error";

export interface KotlinPlaygroundFile {
  /** Top-level `.kt` path in the lesson workspace. */
  path: string;
  content: string;
}

export interface KotlinPlaygroundRunRequest {
  files: readonly KotlinPlaygroundFile[];
}

export interface KotlinPlaygroundRunResult {
  status: KotlinPlaygroundRunStatus;
  /** Program stdout/stderr text concatenated in upstream order. */
  output: string;
  /** Compiler ERROR diagnostics; present exactly when status is "compile-error". */
  compileErrors?: string;
  /** Compiler WARNING diagnostics; rendered separately from program output. */
  warnings?: string;
  /** Formatted uncaught exception; present exactly when status is "runtime-error". */
  exception?: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "compile-error", "runtime-error"]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Validate a decoded Worker response into a run result, or null when the
 * payload does not match the contract. Unknown extra fields are dropped so
 * upstream additions can never leak into app state.
 */
export function parseKotlinPlaygroundRunResult(value: unknown): KotlinPlaygroundRunResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status) ||
    typeof candidate.output !== "string" ||
    !isOptionalString(candidate.compileErrors) ||
    !isOptionalString(candidate.warnings) ||
    !isOptionalString(candidate.exception)
  ) {
    return null;
  }

  const status = candidate.status as KotlinPlaygroundRunStatus;
  const hasCompileErrors =
    typeof candidate.compileErrors === "string" && candidate.compileErrors.trim().length > 0;
  const hasException =
    typeof candidate.exception === "string" && candidate.exception.trim().length > 0;

  // Keep the response a real discriminated contract even though diagnostics
  // are optional at the TypeScript surface. This prevents malformed Worker or
  // cache data from rendering a successful run for an impossible status.
  if (
    (status === "success" &&
      (candidate.compileErrors !== undefined || candidate.exception !== undefined)) ||
    (status === "compile-error" && (!hasCompileErrors || candidate.exception !== undefined)) ||
    (status === "runtime-error" && (!hasException || candidate.compileErrors !== undefined)) ||
    (candidate.warnings !== undefined && candidate.warnings.trim().length === 0)
  ) {
    return null;
  }

  const result: KotlinPlaygroundRunResult = {
    status,
    output: candidate.output,
  };

  if (candidate.compileErrors !== undefined) result.compileErrors = candidate.compileErrors;
  if (candidate.warnings !== undefined) result.warnings = candidate.warnings;
  if (candidate.exception !== undefined) result.exception = candidate.exception;

  return result;
}

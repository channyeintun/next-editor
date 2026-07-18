/**
 * First-party contract between the browser Go Playground client and the main
 * Worker's /api/go-playground/run proxy route. The upstream response shape
 * never crosses this boundary — the Worker normalizes it into
 * `GoPlaygroundRunResult` (docs/go-lessons-selective-runtime-plan.md §7).
 */

export type GoPlaygroundRunStatus = "success" | "compile-error" | "vet-error" | "runtime-error";

export interface GoPlaygroundRunRequest {
  source: string;
}

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

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value));
}

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

  const result: GoPlaygroundRunResult = {
    status: candidate.status as GoPlaygroundRunStatus,
    output: candidate.output,
  };

  if (candidate.compileErrors !== undefined) result.compileErrors = candidate.compileErrors;
  if (candidate.vetErrors !== undefined) result.vetErrors = candidate.vetErrors;
  if (candidate.exitCode !== undefined) result.exitCode = candidate.exitCode;
  if (candidate.isTest !== undefined) result.isTest = candidate.isTest;
  if (candidate.testsFailed !== undefined) result.testsFailed = candidate.testsFailed;

  return result;
}

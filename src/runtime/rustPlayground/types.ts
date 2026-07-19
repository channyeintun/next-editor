/**
 * First-party contracts between the browser Rust Playground client and the
 * main Worker's /api/rust-playground/{run,format} proxy routes. Upstream
 * response shapes never cross this boundary — the Worker normalizes them into
 * the result types below, mirroring the Go and Kotlin Playground contracts.
 */

export type RustPlaygroundRunStatus = "success" | "compile-error" | "runtime-error";

export interface RustPlaygroundFile {
  /** Top-level `.rs` path in the lesson workspace; the Playground runs exactly one `main.rs`. */
  path: string;
  content: string;
}

export interface RustPlaygroundRunRequest {
  files: readonly RustPlaygroundFile[];
}

export interface RustPlaygroundFormatRequest {
  files: readonly RustPlaygroundFile[];
}

export interface RustPlaygroundFormatResult {
  files: RustPlaygroundFile[];
}

export interface RustPlaygroundRunResult {
  status: RustPlaygroundRunStatus;
  /** Program stdout. Empty for compile errors. */
  stdout: string;
  /**
   * Program stderr plus rustc warnings, with cargo build-status lines
   * stripped. Empty for compile errors — their diagnostics live in
   * compileErrors.
   */
  stderr: string;
  /** rustc diagnostics; present exactly when status is "compile-error". */
  compileErrors?: string;
  /** Upstream exit summary (e.g. "Exited with status 101"); present exactly when status is "runtime-error". */
  exitDetail?: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "compile-error", "runtime-error"]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Validate the Worker's normalized rustfmt response. */
export function parseRustPlaygroundFormatResult(value: unknown): RustPlaygroundFormatResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const rawFiles = (value as Record<string, unknown>).files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return null;
  }

  const files: RustPlaygroundFile[] = [];
  const seenPaths = new Set<string>();
  for (const rawFile of rawFiles) {
    if (typeof rawFile !== "object" || rawFile === null) {
      return null;
    }

    const candidate = rawFile as Record<string, unknown>;
    if (
      typeof candidate.path !== "string" ||
      candidate.path.length === 0 ||
      typeof candidate.content !== "string" ||
      seenPaths.has(candidate.path)
    ) {
      return null;
    }

    seenPaths.add(candidate.path);
    files.push({ path: candidate.path, content: candidate.content });
  }

  return { files };
}

/**
 * Validate a decoded Worker response into a run result, or null when the
 * payload does not match the contract. Unknown extra fields are dropped so
 * upstream additions can never leak into app state.
 */
export function parseRustPlaygroundRunResult(value: unknown): RustPlaygroundRunResult | null {
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
    !isOptionalString(candidate.exitDetail)
  ) {
    return null;
  }

  const status = candidate.status as RustPlaygroundRunStatus;
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
    (status === "compile-error" && (!hasCompileErrors || candidate.exitDetail !== undefined)) ||
    (status === "runtime-error" && (!hasExitDetail || candidate.compileErrors !== undefined))
  ) {
    return null;
  }

  const result: RustPlaygroundRunResult = {
    status,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
  };

  if (candidate.compileErrors !== undefined) result.compileErrors = candidate.compileErrors;
  if (candidate.exitDetail !== undefined) result.exitDetail = candidate.exitDetail;

  return result;
}

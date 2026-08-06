/**
 * Contracts for the Kite Playground runner.
 *
 * Unlike the Go, Kotlin and Rust Playgrounds, **there is no Worker proxy and no
 * upstream service.** Kite's compiler targets WebAssembly, so the whole
 * toolchain — check, format, run — instantiates in the browser and answers
 * without a network round trip. That removes a whole class of failure the other
 * three have to model: no authentication, no rate limit, no upstream outage,
 * and no lesson that stops working because a public playground is down.
 *
 * The result types below deliberately mirror the other three anyway, so
 * `playgroundRuntime.ts`, the runner panel and the console helpers treat every
 * language the same way. Only the transport differs.
 */

export type KitePlaygroundRunStatus = "success" | "compile-error" | "runtime-error";

export interface KitePlaygroundFile {
  /** Top-level `.kite` path in the lesson workspace. */
  path: string;
  content: string;
}

export interface KitePlaygroundRunRequest {
  files: readonly KitePlaygroundFile[];
}

export interface KitePlaygroundFormatRequest {
  files: readonly KitePlaygroundFile[];
}

export interface KitePlaygroundFormatResult {
  files: KitePlaygroundFile[];
}

export interface KitePlaygroundRunResult {
  status: KitePlaygroundRunStatus;
  /** Program stdout. Empty for compile errors. */
  stdout: string;
  /** Program stderr — `io.error` output. Empty for compile errors. */
  stderr: string;
  /**
   * Kite diagnostics, rendered exactly as `kitec` renders them in a terminal;
   * present exactly when status is "compile-error".
   */
  compileErrors?: string;
  /** A trap's message, present exactly when status is "runtime-error". */
  exitDetail?: string;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "compile-error", "runtime-error"]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Validate a format result, or null when it does not match the contract. */
export function parseKitePlaygroundFormatResult(value: unknown): KitePlaygroundFormatResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const rawFiles = (value as Record<string, unknown>).files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return null;
  }

  const files: KitePlaygroundFile[] = [];
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
 * Validate a run result, or null when the payload does not match the contract.
 *
 * The compiler is in-process here rather than across a network, so this is
 * cheaper than it looks — but it stays, because a status that disagrees with
 * its own diagnostics would render a successful run for an impossible state,
 * and that is worth catching wherever the value came from.
 */
export function parseKitePlaygroundRunResult(value: unknown): KitePlaygroundRunResult | null {
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

  const status = candidate.status as KitePlaygroundRunStatus;
  const hasCompileErrors =
    typeof candidate.compileErrors === "string" && candidate.compileErrors.trim().length > 0;
  const hasExitDetail =
    typeof candidate.exitDetail === "string" && candidate.exitDetail.trim().length > 0;

  if (
    (status === "success" &&
      (candidate.compileErrors !== undefined || candidate.exitDetail !== undefined)) ||
    (status === "compile-error" && (!hasCompileErrors || candidate.exitDetail !== undefined)) ||
    (status === "runtime-error" && (!hasExitDetail || candidate.compileErrors !== undefined))
  ) {
    return null;
  }

  const result: KitePlaygroundRunResult = {
    status,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
  };

  if (candidate.compileErrors !== undefined) result.compileErrors = candidate.compileErrors;
  if (candidate.exitDetail !== undefined) result.exitDetail = candidate.exitDetail;

  return result;
}

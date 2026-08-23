import {
  parseHaskellPlaygroundRunResult,
  type HaskellPlaygroundFile,
  type HaskellPlaygroundRunRequest,
  type HaskellPlaygroundRunResult,
} from "./types";

/**
 * Why a Haskell run request can fail without producing a result. "aborted"
 * means a newer operation (or unmount) superseded it — callers should ignore
 * that request rather than surface an error.
 */
export type HaskellPlaygroundServiceErrorKind =
  | "unauthenticated"
  | "disabled"
  | "rate-limited"
  | "timeout"
  | "invalid-source"
  | "unavailable"
  | "aborted";

export class HaskellPlaygroundServiceError extends Error {
  readonly kind: HaskellPlaygroundServiceErrorKind;

  constructor(kind: HaskellPlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "HaskellPlaygroundServiceError";
    this.kind = kind;
  }
}

function errorKindForStatus(status: number): HaskellPlaygroundServiceErrorKind {
  switch (status) {
    case 401:
      return "unauthenticated";
    case 503:
      return "disabled";
    case 429:
      return "rate-limited";
    case 504:
      return "timeout";
    case 400:
    case 413:
    case 422:
      return "invalid-source";
    default:
      return "unavailable";
  }
}

/**
 * One abortable HTTP request at a time against the first-party Worker proxy —
 * no filesystem, mount, process, PTY, port, preview, or teardown surface,
 * exactly like the Go, Kotlin, Rust, and Zig Playground clients. Starting a new
 * Run aborts the previous in-flight one, so stale responses can never land
 * after a newer explicit action.
 *
 * Like Kotlin and unlike Go, Rust, and Zig there is no Format operation: the
 * upstream Haskell Playground exposes no formatter endpoint. There is no
 * client-side timer either — upstream caps a run at five seconds and the
 * Worker turns that into a 504, which maps to the "timeout" kind below.
 */
export class HaskellPlaygroundClient {
  private controller: AbortController | null = null;

  async run(files: readonly HaskellPlaygroundFile[]): Promise<HaskellPlaygroundRunResult> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    let response: Response;
    try {
      response = await fetch("/api/haskell-playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files } satisfies HaskellPlaygroundRunRequest),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HaskellPlaygroundServiceError("aborted", "The run was superseded");
      }
      throw new HaskellPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : "The run request failed",
      );
    }

    if (!response.ok) {
      const kind = errorKindForStatus(response.status);
      const message = await response
        .json()
        .then((body: unknown) => {
          const error = (body as { error?: unknown }).error;
          return typeof error === "string" ? error : null;
        })
        .catch(() => null);
      throw new HaskellPlaygroundServiceError(
        kind,
        message ?? `Run failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HaskellPlaygroundServiceError("aborted", "The run was superseded");
      }
      throw new HaskellPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : "The run response could not be read",
      );
    }

    const result = parseHaskellPlaygroundRunResult(payload);
    if (!result) {
      throw new HaskellPlaygroundServiceError(
        "unavailable",
        "The run response had an unexpected shape",
      );
    }
    return result;
  }

  abort(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

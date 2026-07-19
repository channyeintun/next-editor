import {
  parseKotlinPlaygroundRunResult,
  type KotlinPlaygroundRunRequest,
  type KotlinPlaygroundRunResult,
  type KotlinPlaygroundFile,
} from "./types";

/**
 * Why a Kotlin run request can fail without producing a result. "aborted"
 * means a newer operation (or unmount) superseded it — callers should ignore
 * that request rather than surface an error.
 */
export type KotlinPlaygroundServiceErrorKind =
  | "unauthenticated"
  | "disabled"
  | "rate-limited"
  | "timeout"
  | "invalid-source"
  | "unavailable"
  | "aborted";

export class KotlinPlaygroundServiceError extends Error {
  readonly kind: KotlinPlaygroundServiceErrorKind;

  constructor(kind: KotlinPlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "KotlinPlaygroundServiceError";
    this.kind = kind;
  }
}

function errorKindForStatus(status: number): KotlinPlaygroundServiceErrorKind {
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
 * exactly like the Go Playground client. Starting a new Run aborts the
 * previous in-flight one, so stale responses can never land after a newer
 * explicit action. Unlike Go there is no Format operation: the upstream
 * Kotlin Playground exposes no formatter endpoint.
 */
export class KotlinPlaygroundClient {
  private controller: AbortController | null = null;

  async run(files: readonly KotlinPlaygroundFile[]): Promise<KotlinPlaygroundRunResult> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    let response: Response;
    try {
      response = await fetch("/api/kotlin-playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files } satisfies KotlinPlaygroundRunRequest),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new KotlinPlaygroundServiceError("aborted", "The run was superseded");
      }
      throw new KotlinPlaygroundServiceError(
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
      throw new KotlinPlaygroundServiceError(
        kind,
        message ?? `Run failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new KotlinPlaygroundServiceError("aborted", "The run was superseded");
      }
      throw new KotlinPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : "The run response could not be read",
      );
    }

    const result = parseKotlinPlaygroundRunResult(payload);
    if (!result) {
      throw new KotlinPlaygroundServiceError(
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

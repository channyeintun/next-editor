import {
  parseGoPlaygroundRunResult,
  type GoPlaygroundFile,
  type GoPlaygroundRunRequest,
  type GoPlaygroundRunResult,
} from "./types";

/**
 * Why a Run can fail without producing a run result. "aborted" means a newer
 * Run (or unmount) superseded this request — callers should ignore it rather
 * than surface an error.
 */
export type GoPlaygroundServiceErrorKind =
  | "unauthenticated"
  | "disabled"
  | "rate-limited"
  | "timeout"
  | "invalid-source"
  | "unavailable"
  | "aborted";

export class GoPlaygroundServiceError extends Error {
  readonly kind: GoPlaygroundServiceErrorKind;

  constructor(kind: GoPlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "GoPlaygroundServiceError";
    this.kind = kind;
  }
}

function errorKindForStatus(status: number): GoPlaygroundServiceErrorKind {
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
      return "invalid-source";
    default:
      return "unavailable";
  }
}

/**
 * One abortable HTTP request against the first-party Worker proxy — no
 * filesystem, mount, process, PTY, port, preview, or teardown surface
 * (docs/go-lessons-selective-runtime-plan.md §7.1). Starting a new run aborts
 * the previous in-flight one, so at most one request per client is live and
 * stale responses can never land after a newer Run.
 */
export class GoPlaygroundClient {
  private controller: AbortController | null = null;

  async run(files: readonly GoPlaygroundFile[]): Promise<GoPlaygroundRunResult> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    let response: Response;
    try {
      response = await fetch("/api/go-playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files } satisfies GoPlaygroundRunRequest),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GoPlaygroundServiceError("aborted", "The run was superseded");
      }
      throw new GoPlaygroundServiceError(
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
      throw new GoPlaygroundServiceError(
        kind,
        message ?? `Run failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GoPlaygroundServiceError("aborted", "The run was superseded");
      }
      throw new GoPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : "The run response could not be read",
      );
    }

    const result = parseGoPlaygroundRunResult(payload);
    if (!result) {
      throw new GoPlaygroundServiceError("unavailable", "The run response had an unexpected shape");
    }
    return result;
  }

  abort(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

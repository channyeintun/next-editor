import {
  parseGoPlaygroundFormatResult,
  parseGoPlaygroundRunResult,
  type GoPlaygroundFormatRequest,
  type GoPlaygroundFormatResult,
  type GoPlaygroundFile,
  type GoPlaygroundRunRequest,
  type GoPlaygroundRunResult,
} from "./types";

/**
 * Why a Go tool request can fail without producing a result. "aborted" means
 * a newer operation (or unmount) superseded it — callers should ignore that
 * request rather than surface an error.
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
    case 422:
      return "invalid-source";
    default:
      return "unavailable";
  }
}

/**
 * One abortable HTTP request at a time against the first-party Worker proxy — no
 * filesystem, mount, process, PTY, port, preview, or teardown surface
 * (docs/go-lessons-selective-runtime-plan.md §7.1). Starting a Run or Format
 * aborts the previous in-flight operation, so stale responses can never land
 * after a newer explicit action.
 */
export class GoPlaygroundClient {
  private controller: AbortController | null = null;

  async run(files: readonly GoPlaygroundFile[]): Promise<GoPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies GoPlaygroundRunRequest,
      parseGoPlaygroundRunResult,
    );
  }

  async format(files: readonly GoPlaygroundFile[]): Promise<GoPlaygroundFormatResult> {
    const result = await this.request(
      "format",
      { files } satisfies GoPlaygroundFormatRequest,
      parseGoPlaygroundFormatResult,
    );
    const requestedPaths = files.map((file) => file.path).sort();
    const formattedPaths = result.files.map((file) => file.path).sort();
    if (
      requestedPaths.length !== formattedPaths.length ||
      requestedPaths.some((path, index) => path !== formattedPaths[index])
    ) {
      throw new GoPlaygroundServiceError(
        "unavailable",
        "The format response did not contain the submitted Go files",
      );
    }
    return result;
  }

  private async request<T>(
    operation: "run" | "format",
    request: GoPlaygroundRunRequest | GoPlaygroundFormatRequest,
    parseResult: (value: unknown) => T | null,
  ): Promise<T> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const operationLabel = operation === "run" ? "Run" : "Format";

    let response: Response;
    try {
      response = await fetch(`/api/go-playground/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GoPlaygroundServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new GoPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : `The ${operation} request failed`,
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
        message ?? `${operationLabel} failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GoPlaygroundServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new GoPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : `The ${operation} response could not be read`,
      );
    }

    const result = parseResult(payload);
    if (!result) {
      throw new GoPlaygroundServiceError(
        "unavailable",
        `The ${operation} response had an unexpected shape`,
      );
    }
    return result;
  }

  abort(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

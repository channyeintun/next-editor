import {
  parseRustPlaygroundFormatResult,
  parseRustPlaygroundRunResult,
  type RustPlaygroundFile,
  type RustPlaygroundFormatRequest,
  type RustPlaygroundFormatResult,
  type RustPlaygroundRunRequest,
  type RustPlaygroundRunResult,
} from "./types";

/**
 * Why a Rust tool request can fail without producing a result. "aborted"
 * means a newer operation (or unmount) superseded it — callers should ignore
 * that request rather than surface an error.
 */
export type RustPlaygroundServiceErrorKind =
  | "unauthenticated"
  | "disabled"
  | "rate-limited"
  | "timeout"
  | "invalid-source"
  | "unavailable"
  | "aborted";

export class RustPlaygroundServiceError extends Error {
  readonly kind: RustPlaygroundServiceErrorKind;

  constructor(kind: RustPlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "RustPlaygroundServiceError";
    this.kind = kind;
  }
}

function errorKindForStatus(status: number): RustPlaygroundServiceErrorKind {
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
 * exactly like the Go and Kotlin Playground clients. Starting a Run or Format
 * aborts the previous in-flight operation, so stale responses can never land
 * after a newer explicit action.
 */
export class RustPlaygroundClient {
  private controller: AbortController | null = null;

  async run(files: readonly RustPlaygroundFile[]): Promise<RustPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies RustPlaygroundRunRequest,
      parseRustPlaygroundRunResult,
    );
  }

  async format(files: readonly RustPlaygroundFile[]): Promise<RustPlaygroundFormatResult> {
    const result = await this.request(
      "format",
      { files } satisfies RustPlaygroundFormatRequest,
      parseRustPlaygroundFormatResult,
    );
    const requestedPaths = files.map((file) => file.path).sort();
    const formattedPaths = result.files.map((file) => file.path).sort();
    if (
      requestedPaths.length !== formattedPaths.length ||
      requestedPaths.some((path, index) => path !== formattedPaths[index])
    ) {
      throw new RustPlaygroundServiceError(
        "unavailable",
        "The format response did not contain the submitted Rust files",
      );
    }
    return result;
  }

  private async request<T>(
    operation: "run" | "format",
    request: RustPlaygroundRunRequest | RustPlaygroundFormatRequest,
    parseResult: (value: unknown) => T | null,
  ): Promise<T> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const operationLabel = operation === "run" ? "Run" : "Format";

    let response: Response;
    try {
      response = await fetch(`/api/rust-playground/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RustPlaygroundServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new RustPlaygroundServiceError(
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
      throw new RustPlaygroundServiceError(
        kind,
        message ?? `${operationLabel} failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RustPlaygroundServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new RustPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : `The ${operation} response could not be read`,
      );
    }

    const result = parseResult(payload);
    if (!result) {
      throw new RustPlaygroundServiceError(
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

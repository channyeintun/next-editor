import {
  parseZigPlaygroundFormatResult,
  parseZigPlaygroundRunResult,
  type ZigPlaygroundFile,
  type ZigPlaygroundFormatRequest,
  type ZigPlaygroundFormatResult,
  type ZigPlaygroundRunRequest,
  type ZigPlaygroundRunResult,
} from "./types";

/**
 * Why a Zig tool request can fail without producing a result. "aborted"
 * means a newer operation (or unmount) superseded it — callers should ignore
 * that request rather than surface an error.
 */
export type ZigPlaygroundServiceErrorKind =
  | "unauthenticated"
  | "disabled"
  | "rate-limited"
  | "timeout"
  | "invalid-source"
  | "unavailable"
  | "aborted";

export class ZigPlaygroundServiceError extends Error {
  readonly kind: ZigPlaygroundServiceErrorKind;

  constructor(kind: ZigPlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "ZigPlaygroundServiceError";
    this.kind = kind;
  }
}

function errorKindForStatus(status: number): ZigPlaygroundServiceErrorKind {
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
 * exactly like the Go, Kotlin, and Rust Playground clients. Starting a Run or
 * Format aborts the previous in-flight operation, so stale responses can never
 * land after a newer explicit action.
 */
export class ZigPlaygroundClient {
  private controller: AbortController | null = null;

  async run(files: readonly ZigPlaygroundFile[]): Promise<ZigPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies ZigPlaygroundRunRequest,
      parseZigPlaygroundRunResult,
    );
  }

  async format(files: readonly ZigPlaygroundFile[]): Promise<ZigPlaygroundFormatResult> {
    const result = await this.request(
      "format",
      { files } satisfies ZigPlaygroundFormatRequest,
      parseZigPlaygroundFormatResult,
    );
    const requestedPaths = files.map((file) => file.path).sort();
    const formattedPaths = result.files.map((file) => file.path).sort();
    if (
      requestedPaths.length !== formattedPaths.length ||
      requestedPaths.some((path, index) => path !== formattedPaths[index])
    ) {
      throw new ZigPlaygroundServiceError(
        "unavailable",
        "The format response did not contain the submitted Zig files",
      );
    }
    return result;
  }

  private async request<T>(
    operation: "run" | "format",
    request: ZigPlaygroundRunRequest | ZigPlaygroundFormatRequest,
    parseResult: (value: unknown) => T | null,
  ): Promise<T> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const operationLabel = operation === "run" ? "Run" : "Format";

    let response: Response;
    try {
      response = await fetch(`/api/zig-playground/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ZigPlaygroundServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new ZigPlaygroundServiceError(
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
      throw new ZigPlaygroundServiceError(
        kind,
        message ?? `${operationLabel} failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ZigPlaygroundServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new ZigPlaygroundServiceError(
        "unavailable",
        error instanceof Error ? error.message : `The ${operation} response could not be read`,
      );
    }

    const result = parseResult(payload);
    if (!result) {
      throw new ZigPlaygroundServiceError(
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

// The browser half of the first-party playground proxy shared by the Go, Rust,
// Zig, Kotlin and Haskell clients; infra/worker/playgroundProxy.ts is the
// Worker half. Only the parts that are identical across those languages live
// here — the non-ok status contract, the abortable request and its error
// messages, and the format response's path check. Each language's client keeps
// its route, its result parsers and its own error class, so `instanceof` still
// tells one language's errors from another's.

/**
 * Why a proxied playground request can fail without producing a result.
 * "aborted" means a newer operation (or unmount) superseded it — callers should
 * ignore that request rather than surface an error.
 */
export type PlaygroundProxyErrorKind =
  | "disabled"
  | "rate-limited"
  | "timeout"
  | "invalid-source"
  | "unavailable"
  | "aborted";

/** What every proxied language's service error carries; each language names its own subclass. */
export abstract class PlaygroundProxyServiceError extends Error {
  readonly kind: PlaygroundProxyErrorKind;

  constructor(kind: PlaygroundProxyErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** How the Worker's non-ok statuses read on the client, the same for every proxied language. */
export function errorKindForStatus(status: number): PlaygroundProxyErrorKind {
  switch (status) {
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

type PlaygroundProxyOperation = "run" | "format";

/**
 * One abortable HTTP request at a time against the first-party Worker proxy —
 * no filesystem, mount, process, PTY, port, preview, or teardown surface
 * (docs/go-lessons-selective-runtime-plan.md §7.1). Starting a new operation
 * aborts the previous in-flight one, so stale responses can never land after a
 * newer explicit action.
 */
export abstract class PlaygroundProxyClient<ServiceError extends PlaygroundProxyServiceError> {
  private controller: AbortController | null = null;
  private readonly route: string;
  private readonly ServiceError: new (
    kind: PlaygroundProxyErrorKind,
    message: string,
  ) => ServiceError;

  /** `route` is the proxy's base path, such as `/api/go-playground`. */
  protected constructor(
    route: string,
    ServiceError: new (kind: PlaygroundProxyErrorKind, message: string) => ServiceError,
  ) {
    this.route = route;
    this.ServiceError = ServiceError;
  }

  protected async request<T>(
    operation: PlaygroundProxyOperation,
    body: unknown,
    parseResult: (value: unknown) => T | null,
  ): Promise<T> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const operationLabel = operation === "run" ? "Run" : "Format";

    let response: Response;
    try {
      response = await fetch(`${this.route}/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new this.ServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new this.ServiceError(
        "unavailable",
        error instanceof Error ? error.message : `The ${operation} request failed`,
      );
    }

    if (!response.ok) {
      const kind = errorKindForStatus(response.status);
      const message = await response
        .json()
        .then((errorBody: unknown) => {
          const error = (errorBody as { error?: unknown }).error;
          return typeof error === "string" ? error : null;
        })
        .catch(() => null);
      throw new this.ServiceError(
        kind,
        message ?? `${operationLabel} failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new this.ServiceError("aborted", `The ${operation} was superseded`);
      }
      throw new this.ServiceError(
        "unavailable",
        error instanceof Error ? error.message : `The ${operation} response could not be read`,
      );
    }

    const result = parseResult(payload);
    if (!result) {
      throw new this.ServiceError(
        "unavailable",
        `The ${operation} response had an unexpected shape`,
      );
    }
    return result;
  }

  /**
   * Format `files` and insist the response holds exactly the submitted paths,
   * so a formatter can never add, drop or rename a lesson file.
   */
  protected async formatFiles<Result extends { files: readonly { path: string }[] }>(
    files: readonly { path: string }[],
    parseResult: (value: unknown) => Result | null,
    languageNoun: string,
  ): Promise<Result> {
    const result = await this.request("format", { files }, parseResult);
    const requestedPaths = files.map((file) => file.path).sort();
    const formattedPaths = result.files.map((file) => file.path).sort();
    if (
      requestedPaths.length !== formattedPaths.length ||
      requestedPaths.some((path, index) => path !== formattedPaths[index])
    ) {
      throw new this.ServiceError(
        "unavailable",
        `The format response did not contain the submitted ${languageNoun} files`,
      );
    }
    return result;
  }

  abort(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

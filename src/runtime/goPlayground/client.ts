import {
  PlaygroundProxyClient,
  PlaygroundProxyServiceError,
  type PlaygroundProxyErrorKind,
} from "../playgroundProxyClient";
import {
  parseGoPlaygroundFormatResult,
  parseGoPlaygroundRunResult,
  type GoPlaygroundFile,
  type GoPlaygroundFormatResult,
  type GoPlaygroundRunRequest,
  type GoPlaygroundRunResult,
} from "./types";

/** Why a Go tool request can fail without producing a result: the shared proxy kinds. */
export type GoPlaygroundServiceErrorKind = PlaygroundProxyErrorKind;

export class GoPlaygroundServiceError extends PlaygroundProxyServiceError {
  constructor(kind: GoPlaygroundServiceErrorKind, message: string) {
    super(kind, message);
    this.name = "GoPlaygroundServiceError";
  }
}

/**
 * Runs and gofmt-formats Go lessons through `/api/go-playground`; the shared
 * request, abort and status contract live in {@link PlaygroundProxyClient}.
 */
export class GoPlaygroundClient extends PlaygroundProxyClient<GoPlaygroundServiceError> {
  constructor() {
    super("/api/go-playground", GoPlaygroundServiceError);
  }

  run(files: readonly GoPlaygroundFile[]): Promise<GoPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies GoPlaygroundRunRequest,
      parseGoPlaygroundRunResult,
    );
  }

  format(files: readonly GoPlaygroundFile[]): Promise<GoPlaygroundFormatResult> {
    return this.formatFiles(files, parseGoPlaygroundFormatResult, "Go");
  }
}

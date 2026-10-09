import {
  PlaygroundProxyClient,
  PlaygroundProxyServiceError,
  type PlaygroundProxyErrorKind,
} from "../playgroundProxyClient";
import {
  parseRustPlaygroundFormatResult,
  parseRustPlaygroundRunResult,
  type RustPlaygroundFile,
  type RustPlaygroundFormatResult,
  type RustPlaygroundRunRequest,
  type RustPlaygroundRunResult,
} from "./types";

/** Why a Rust tool request can fail without producing a result: the shared proxy kinds. */
export type RustPlaygroundServiceErrorKind = PlaygroundProxyErrorKind;

export class RustPlaygroundServiceError extends PlaygroundProxyServiceError {
  constructor(kind: RustPlaygroundServiceErrorKind, message: string) {
    super(kind, message);
    this.name = "RustPlaygroundServiceError";
  }
}

/**
 * Runs and rustfmt-formats Rust lessons through `/api/rust-playground`, exactly
 * like the Go client; the shared request, abort and status contract live in
 * {@link PlaygroundProxyClient}.
 */
export class RustPlaygroundClient extends PlaygroundProxyClient<RustPlaygroundServiceError> {
  constructor() {
    super("/api/rust-playground", RustPlaygroundServiceError);
  }

  run(files: readonly RustPlaygroundFile[]): Promise<RustPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies RustPlaygroundRunRequest,
      parseRustPlaygroundRunResult,
    );
  }

  format(files: readonly RustPlaygroundFile[]): Promise<RustPlaygroundFormatResult> {
    return this.formatFiles(files, parseRustPlaygroundFormatResult, "Rust");
  }
}

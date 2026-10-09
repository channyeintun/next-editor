import {
  PlaygroundProxyClient,
  PlaygroundProxyServiceError,
  type PlaygroundProxyErrorKind,
} from "../playgroundProxyClient";
import {
  parseHaskellPlaygroundRunResult,
  type HaskellPlaygroundFile,
  type HaskellPlaygroundRunRequest,
  type HaskellPlaygroundRunResult,
} from "./types";

/** Why a Haskell run request can fail without producing a result: the shared proxy kinds. */
export type HaskellPlaygroundServiceErrorKind = PlaygroundProxyErrorKind;

export class HaskellPlaygroundServiceError extends PlaygroundProxyServiceError {
  constructor(kind: HaskellPlaygroundServiceErrorKind, message: string) {
    super(kind, message);
    this.name = "HaskellPlaygroundServiceError";
  }
}

/**
 * Runs Haskell lessons through `/api/haskell-playground`, exactly like the Go,
 * Kotlin, Rust, and Zig Playground clients; the shared request, abort and
 * status contract live in {@link PlaygroundProxyClient}.
 *
 * Like Kotlin and unlike Go, Rust, and Zig there is no Format operation: the
 * upstream Haskell Playground exposes no formatter endpoint. There is no
 * client-side timer either — upstream caps a run at five seconds and the
 * Worker turns that into a 504, which maps to the "timeout" kind.
 */
export class HaskellPlaygroundClient extends PlaygroundProxyClient<HaskellPlaygroundServiceError> {
  constructor() {
    super("/api/haskell-playground", HaskellPlaygroundServiceError);
  }

  run(files: readonly HaskellPlaygroundFile[]): Promise<HaskellPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies HaskellPlaygroundRunRequest,
      parseHaskellPlaygroundRunResult,
    );
  }
}

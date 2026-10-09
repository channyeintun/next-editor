import {
  PlaygroundProxyClient,
  PlaygroundProxyServiceError,
  type PlaygroundProxyErrorKind,
} from "../playgroundProxyClient";
import {
  parseKotlinPlaygroundRunResult,
  type KotlinPlaygroundRunRequest,
  type KotlinPlaygroundRunResult,
  type KotlinPlaygroundFile,
} from "./types";

/** Why a Kotlin run request can fail without producing a result: the shared proxy kinds. */
export type KotlinPlaygroundServiceErrorKind = PlaygroundProxyErrorKind;

export class KotlinPlaygroundServiceError extends PlaygroundProxyServiceError {
  constructor(kind: KotlinPlaygroundServiceErrorKind, message: string) {
    super(kind, message);
    this.name = "KotlinPlaygroundServiceError";
  }
}

/**
 * Runs Kotlin lessons through `/api/kotlin-playground`, exactly like the Go
 * Playground client; the shared request, abort and status contract live in
 * {@link PlaygroundProxyClient}. Unlike Go there is no Format operation: the
 * upstream Kotlin Playground exposes no formatter endpoint.
 */
export class KotlinPlaygroundClient extends PlaygroundProxyClient<KotlinPlaygroundServiceError> {
  constructor() {
    super("/api/kotlin-playground", KotlinPlaygroundServiceError);
  }

  run(files: readonly KotlinPlaygroundFile[]): Promise<KotlinPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies KotlinPlaygroundRunRequest,
      parseKotlinPlaygroundRunResult,
    );
  }
}

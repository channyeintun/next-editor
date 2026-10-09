import {
  PlaygroundProxyClient,
  PlaygroundProxyServiceError,
  type PlaygroundProxyErrorKind,
} from "../playgroundProxyClient";
import {
  parseZigPlaygroundFormatResult,
  parseZigPlaygroundRunResult,
  type ZigPlaygroundFile,
  type ZigPlaygroundFormatResult,
  type ZigPlaygroundRunRequest,
  type ZigPlaygroundRunResult,
} from "./types";

/** Why a Zig tool request can fail without producing a result: the shared proxy kinds. */
export type ZigPlaygroundServiceErrorKind = PlaygroundProxyErrorKind;

export class ZigPlaygroundServiceError extends PlaygroundProxyServiceError {
  constructor(kind: ZigPlaygroundServiceErrorKind, message: string) {
    super(kind, message);
    this.name = "ZigPlaygroundServiceError";
  }
}

/**
 * Runs and `zig fmt`-formats Zig lessons through `/api/zig-playground`, exactly
 * like the Go and Rust clients; the shared request, abort and status contract
 * live in {@link PlaygroundProxyClient}.
 */
export class ZigPlaygroundClient extends PlaygroundProxyClient<ZigPlaygroundServiceError> {
  constructor() {
    super("/api/zig-playground", ZigPlaygroundServiceError);
  }

  run(files: readonly ZigPlaygroundFile[]): Promise<ZigPlaygroundRunResult> {
    return this.request(
      "run",
      { files } satisfies ZigPlaygroundRunRequest,
      parseZigPlaygroundRunResult,
    );
  }

  format(files: readonly ZigPlaygroundFile[]): Promise<ZigPlaygroundFormatResult> {
    return this.formatFiles(files, parseZigPlaygroundFormatResult, "Zig");
  }
}

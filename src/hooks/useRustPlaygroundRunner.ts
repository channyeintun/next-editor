import {
  RustPlaygroundClient,
  RustPlaygroundServiceError,
  type RustPlaygroundServiceErrorKind,
} from "../runtime/rustPlayground/client";
import type { RustPlaygroundFile } from "../runtime/rustPlayground/types";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

const RUST_PLAYGROUND: PlaygroundClientBinding<
  RustPlaygroundClient,
  RustPlaygroundServiceErrorKind
> = {
  create: () => new RustPlaygroundClient(),
  stop: (client) => client.abort(),
  ServiceError: RustPlaygroundServiceError,
};

/** Rust Run and Format (`rustfmt`) for a lesson, through the Rust tool service. */
export function useRustPlaygroundRunner() {
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    RustPlaygroundClient,
    "run" | "format",
    RustPlaygroundServiceErrorKind
  >(RUST_PLAYGROUND);

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run: (files: readonly RustPlaygroundFile[]) => request("run", (client) => client.run(files)),
    format: (files: readonly RustPlaygroundFile[]) =>
      request("format", (client) => client.format(files)),
    cancel,
  };
}

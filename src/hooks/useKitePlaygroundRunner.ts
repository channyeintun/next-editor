import {
  KitePlaygroundClient,
  KitePlaygroundServiceError,
  type KitePlaygroundServiceErrorKind,
} from "../runtime/kitePlayground/client";
import type { KitePlaygroundFile } from "../runtime/kitePlayground/types";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

const KITE_PLAYGROUND: PlaygroundClientBinding<
  KitePlaygroundClient,
  KitePlaygroundServiceErrorKind
> = {
  create: () => new KitePlaygroundClient(),
  stop: (client) => client.dispose(),
  ServiceError: KitePlaygroundServiceError,
};

/**
 * Kite Run and Format for a lesson. There is no service behind this: the compiler is WebAssembly
 * instantiated in the page and cached by the client across runs (only the first Run pays for the
 * load), so cancelling disposes of the pending run instead of aborting a request, and a Kite
 * lesson is never unauthenticated or rate limited.
 */
export function useKitePlaygroundRunner() {
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    KitePlaygroundClient,
    "run" | "format",
    KitePlaygroundServiceErrorKind
  >(KITE_PLAYGROUND);

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run: (files: readonly KitePlaygroundFile[]) =>
      request("run", (client) => client.run({ files })),
    format: (files: readonly KitePlaygroundFile[]) =>
      request("format", (client) => client.format({ files })),
    cancel,
  };
}

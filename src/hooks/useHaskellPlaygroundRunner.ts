import {
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceError,
  type HaskellPlaygroundServiceErrorKind,
} from "../runtime/haskellPlayground/client";
import type { HaskellPlaygroundFile } from "../runtime/haskellPlayground/types";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

const HASKELL_PLAYGROUND: PlaygroundClientBinding<
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceErrorKind
> = {
  create: () => new HaskellPlaygroundClient(),
  stop: (client) => client.abort(),
  ServiceError: HaskellPlaygroundServiceError,
};

/**
 * Haskell Run for a lesson, through the Haskell tool service. There is no Format:
 * play.haskell.org exposes a single /submit route and no formatter endpoint.
 */
export function useHaskellPlaygroundRunner() {
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    HaskellPlaygroundClient,
    "run",
    HaskellPlaygroundServiceErrorKind
  >(HASKELL_PLAYGROUND);

  return {
    isRunning: activeOperation === "run",
    run: (files: readonly HaskellPlaygroundFile[]) => request("run", (client) => client.run(files)),
    cancel,
  };
}

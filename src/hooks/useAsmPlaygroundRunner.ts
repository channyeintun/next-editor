import {
  AsmPlaygroundClient,
  AsmPlaygroundServiceError,
  type AsmPlaygroundServiceErrorKind,
} from "../runtime/asmPlayground/client";
import type { AsmPlaygroundFile } from "../runtime/asmPlayground/types";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

const ASM_PLAYGROUND: PlaygroundClientBinding<AsmPlaygroundClient, AsmPlaygroundServiceErrorKind> =
  {
    create: () => new AsmPlaygroundClient(),
    stop: (client) => client.dispose(),
    ServiceError: AsmPlaygroundServiceError,
  };

/**
 * Assembly Run for a lesson. There is no service and not even a compiler to load: the client
 * assembles and runs in the page, so cancelling disposes of the pending run instead of aborting a
 * request, and an assembly lesson is never unauthenticated or rate limited.
 */
export function useAsmPlaygroundRunner() {
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    AsmPlaygroundClient,
    "run",
    AsmPlaygroundServiceErrorKind
  >(ASM_PLAYGROUND);

  return {
    isRunning: activeOperation === "run",
    run: (files: readonly AsmPlaygroundFile[], stdin?: string) =>
      request("run", (client) => client.run({ files, stdin })),
    cancel,
  };
}

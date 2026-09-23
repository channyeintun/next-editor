import {
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceError,
  type KotlinPlaygroundServiceErrorKind,
} from "../runtime/kotlinPlayground/client";
import type { KotlinPlaygroundFile } from "../runtime/kotlinPlayground/types";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

const KOTLIN_PLAYGROUND: PlaygroundClientBinding<
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceErrorKind
> = {
  create: () => new KotlinPlaygroundClient(),
  stop: (client) => client.abort(),
  ServiceError: KotlinPlaygroundServiceError,
};

/**
 * Kotlin Run for a lesson, through the Kotlin tool service. There is no Format: upstream exposes
 * no formatter.
 */
export function useKotlinPlaygroundRunner() {
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    KotlinPlaygroundClient,
    "run",
    KotlinPlaygroundServiceErrorKind
  >(KOTLIN_PLAYGROUND);

  return {
    isRunning: activeOperation === "run",
    run: (files: readonly KotlinPlaygroundFile[]) => request("run", (client) => client.run(files)),
    cancel,
  };
}

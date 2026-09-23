import {
  GoPlaygroundClient,
  GoPlaygroundServiceError,
  type GoPlaygroundServiceErrorKind,
} from "../runtime/goPlayground/client";
import type { GoPlaygroundFile } from "../runtime/goPlayground/types";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

const GO_PLAYGROUND: PlaygroundClientBinding<GoPlaygroundClient, GoPlaygroundServiceErrorKind> = {
  create: () => new GoPlaygroundClient(),
  stop: (client) => client.abort(),
  ServiceError: GoPlaygroundServiceError,
};

/** Go Run (`go run`) and Format (`gofmt`) for a lesson, through the Go tool service. */
export function useGoPlaygroundRunner() {
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    GoPlaygroundClient,
    "run" | "format",
    GoPlaygroundServiceErrorKind
  >(GO_PLAYGROUND);

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run: (files: readonly GoPlaygroundFile[]) => request("run", (client) => client.run(files)),
    format: (files: readonly GoPlaygroundFile[]) =>
      request("format", (client) => client.format(files)),
    cancel,
  };
}

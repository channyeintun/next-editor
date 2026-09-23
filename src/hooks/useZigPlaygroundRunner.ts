import {
  ZigPlaygroundClient,
  ZigPlaygroundServiceError,
  type ZigPlaygroundServiceErrorKind,
} from "../runtime/zigPlayground/client";
import type { ZigPlaygroundFile } from "../runtime/zigPlayground/types";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

const ZIG_PLAYGROUND: PlaygroundClientBinding<ZigPlaygroundClient, ZigPlaygroundServiceErrorKind> =
  {
    create: () => new ZigPlaygroundClient(),
    stop: (client) => client.abort(),
    ServiceError: ZigPlaygroundServiceError,
  };

/** Zig Run and Format (`zig fmt`) for a lesson, through the Zig tool service. */
export function useZigPlaygroundRunner() {
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    ZigPlaygroundClient,
    "run" | "format",
    ZigPlaygroundServiceErrorKind
  >(ZIG_PLAYGROUND);

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run: (files: readonly ZigPlaygroundFile[]) => request("run", (client) => client.run(files)),
    format: (files: readonly ZigPlaygroundFile[]) =>
      request("format", (client) => client.format(files)),
    cancel,
  };
}

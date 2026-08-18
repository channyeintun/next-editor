import { useCallback, useEffect, useRef, useState } from "react";
import {
  ZigPlaygroundClient,
  ZigPlaygroundServiceError,
  type ZigPlaygroundServiceErrorKind,
} from "../runtime/zigPlayground/client";
import type {
  ZigPlaygroundFile,
  ZigPlaygroundFormatResult,
  ZigPlaygroundRunResult,
} from "../runtime/zigPlayground/types";

type ZigPlaygroundRequestOutcome<Result> =
  | { kind: "result"; result: Result }
  | {
      kind: "service-error";
      errorKind: Exclude<ZigPlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer operation (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

export type ZigPlaygroundRunOutcome = ZigPlaygroundRequestOutcome<ZigPlaygroundRunResult>;
export type ZigPlaygroundFormatOutcome = ZigPlaygroundRequestOutcome<ZigPlaygroundFormatResult>;

type ZigPlaygroundOperation = "run" | "format";

/**
 * Explicit Zig-tool orchestration for lessons, mirroring
 * useGoPlaygroundRunner. Owns one ZigPlaygroundClient so a newer Run or
 * Format aborts the in-flight request, and unmounting (route change,
 * switching lesson types) aborts whatever is left — nothing here ever calls
 * the service from lesson load or playback.
 */
export function useZigPlaygroundRunner() {
  const clientRef = useRef<ZigPlaygroundClient | null>(null);
  const activeRequestRef = useRef(0);
  const [activeOperation, setActiveOperation] = useState<ZigPlaygroundOperation | null>(null);

  useEffect(() => {
    return () => {
      activeRequestRef.current += 1;
      clientRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    activeRequestRef.current += 1;
    clientRef.current?.abort();
    setActiveOperation(null);
  }, []);

  const request = async <Result>(
    operation: ZigPlaygroundOperation,
    execute: (client: ZigPlaygroundClient) => Promise<Result>,
  ): Promise<ZigPlaygroundRequestOutcome<Result>> => {
    const client = (clientRef.current ??= new ZigPlaygroundClient());
    const requestId = ++activeRequestRef.current;
    setActiveOperation(operation);

    const finish = (
      outcome: ZigPlaygroundRequestOutcome<Result>,
    ): ZigPlaygroundRequestOutcome<Result> => {
      // Only the newest request owns the operation flag; a superseded request
      // resolving late (the client already aborted it) must not clear newer state.
      if (requestId === activeRequestRef.current) {
        setActiveOperation(null);
      }
      return requestId === activeRequestRef.current ? outcome : { kind: "superseded" };
    };

    try {
      return finish({ kind: "result", result: await execute(client) });
    } catch (error) {
      if (error instanceof ZigPlaygroundServiceError) {
        if (error.kind === "aborted") {
          return { kind: "superseded" };
        }
        return finish({ kind: "service-error", errorKind: error.kind, message: error.message });
      }
      return finish({
        kind: "service-error",
        errorKind: "unavailable",
        message: error instanceof Error ? error.message : `The ${operation} request failed`,
      });
    }
  };

  const run = (files: readonly ZigPlaygroundFile[]): Promise<ZigPlaygroundRunOutcome> =>
    request("run", (client) => client.run(files));

  const format = (files: readonly ZigPlaygroundFile[]): Promise<ZigPlaygroundFormatOutcome> =>
    request("format", (client) => client.format(files));

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run,
    format,
    cancel,
  };
}

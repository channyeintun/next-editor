import { useCallback, useEffect, useRef, useState } from "react";
import {
  GoPlaygroundClient,
  GoPlaygroundServiceError,
  type GoPlaygroundServiceErrorKind,
} from "../runtime/goPlayground/client";
import type {
  GoPlaygroundFile,
  GoPlaygroundFormatResult,
  GoPlaygroundRunResult,
} from "../runtime/goPlayground/types";

type GoPlaygroundRequestOutcome<Result> =
  | { kind: "result"; result: Result }
  | {
      kind: "service-error";
      errorKind: Exclude<GoPlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer operation (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

export type GoPlaygroundRunOutcome = GoPlaygroundRequestOutcome<GoPlaygroundRunResult>;
export type GoPlaygroundFormatOutcome = GoPlaygroundRequestOutcome<GoPlaygroundFormatResult>;

export interface GoPlaygroundRunnerState {
  isRunning: boolean;
  isFormatting: boolean;
}

type GoPlaygroundOperation = "run" | "format";

/**
 * Explicit Go-tool orchestration for lessons. Owns one GoPlaygroundClient so a
 * newer Run or Format aborts the in-flight request, and unmounting (route
 * change, switching lesson types) aborts whatever is left — nothing here ever
 * calls the service from lesson load or playback.
 */
export function useGoPlaygroundRunner() {
  const clientRef = useRef<GoPlaygroundClient | null>(null);
  const activeRequestRef = useRef(0);
  const [activeOperation, setActiveOperation] = useState<GoPlaygroundOperation | null>(null);

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
    operation: GoPlaygroundOperation,
    execute: (client: GoPlaygroundClient) => Promise<Result>,
  ): Promise<GoPlaygroundRequestOutcome<Result>> => {
    const client = (clientRef.current ??= new GoPlaygroundClient());
    const requestId = ++activeRequestRef.current;
    setActiveOperation(operation);

    const finish = (
      outcome: GoPlaygroundRequestOutcome<Result>,
    ): GoPlaygroundRequestOutcome<Result> => {
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
      if (error instanceof GoPlaygroundServiceError) {
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

  const run = (files: readonly GoPlaygroundFile[]): Promise<GoPlaygroundRunOutcome> =>
    request("run", (client) => client.run(files));

  const format = (files: readonly GoPlaygroundFile[]): Promise<GoPlaygroundFormatOutcome> =>
    request("format", (client) => client.format(files));

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run,
    format,
    cancel,
  };
}

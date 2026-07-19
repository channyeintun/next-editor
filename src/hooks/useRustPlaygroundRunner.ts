import { useCallback, useEffect, useRef, useState } from "react";
import {
  RustPlaygroundClient,
  RustPlaygroundServiceError,
  type RustPlaygroundServiceErrorKind,
} from "../runtime/rustPlayground/client";
import type {
  RustPlaygroundFile,
  RustPlaygroundFormatResult,
  RustPlaygroundRunResult,
} from "../runtime/rustPlayground/types";

type RustPlaygroundRequestOutcome<Result> =
  | { kind: "result"; result: Result }
  | {
      kind: "service-error";
      errorKind: Exclude<RustPlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer operation (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

export type RustPlaygroundRunOutcome = RustPlaygroundRequestOutcome<RustPlaygroundRunResult>;
export type RustPlaygroundFormatOutcome = RustPlaygroundRequestOutcome<RustPlaygroundFormatResult>;

type RustPlaygroundOperation = "run" | "format";

/**
 * Explicit Rust-tool orchestration for lessons, mirroring
 * useGoPlaygroundRunner. Owns one RustPlaygroundClient so a newer Run or
 * Format aborts the in-flight request, and unmounting (route change,
 * switching lesson types) aborts whatever is left — nothing here ever calls
 * the service from lesson load or playback.
 */
export function useRustPlaygroundRunner() {
  const clientRef = useRef<RustPlaygroundClient | null>(null);
  const activeRequestRef = useRef(0);
  const [activeOperation, setActiveOperation] = useState<RustPlaygroundOperation | null>(null);

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
    operation: RustPlaygroundOperation,
    execute: (client: RustPlaygroundClient) => Promise<Result>,
  ): Promise<RustPlaygroundRequestOutcome<Result>> => {
    const client = (clientRef.current ??= new RustPlaygroundClient());
    const requestId = ++activeRequestRef.current;
    setActiveOperation(operation);

    const finish = (
      outcome: RustPlaygroundRequestOutcome<Result>,
    ): RustPlaygroundRequestOutcome<Result> => {
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
      if (error instanceof RustPlaygroundServiceError) {
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

  const run = (files: readonly RustPlaygroundFile[]): Promise<RustPlaygroundRunOutcome> =>
    request("run", (client) => client.run(files));

  const format = (files: readonly RustPlaygroundFile[]): Promise<RustPlaygroundFormatOutcome> =>
    request("format", (client) => client.format(files));

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run,
    format,
    cancel,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  KitePlaygroundClient,
  KitePlaygroundServiceError,
  type KitePlaygroundServiceErrorKind,
} from "../runtime/kitePlayground/client";
import type {
  KitePlaygroundFile,
  KitePlaygroundFormatResult,
  KitePlaygroundRunResult,
} from "../runtime/kitePlayground/types";

type KitePlaygroundRequestOutcome<Result> =
  | { kind: "result"; result: Result }
  | {
      kind: "service-error";
      errorKind: Exclude<KitePlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer operation (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

export type KitePlaygroundRunOutcome = KitePlaygroundRequestOutcome<KitePlaygroundRunResult>;
export type KitePlaygroundFormatOutcome = KitePlaygroundRequestOutcome<KitePlaygroundFormatResult>;

type KitePlaygroundOperation = "run" | "format";

/**
 * Explicit Kite-tool orchestration for lessons, mirroring
 * useRustPlaygroundRunner. Owns one KitePlaygroundClient so a newer Run or
 * Format supersedes the previous one, and unmounting (route change, switching
 * lesson types) discards whatever is left.
 *
 * The difference from the other three: there is no service behind this, so
 * "cancel" is a generation bump rather than an aborted request, and a Kite
 * lesson can never be unauthenticated or rate limited. The compiler is
 * WebAssembly instantiated in the page, and the client caches it across runs —
 * only the first Run pays for the load.
 */
export function useKitePlaygroundRunner() {
  const clientRef = useRef<KitePlaygroundClient | null>(null);
  const activeRequestRef = useRef(0);
  const [activeOperation, setActiveOperation] = useState<KitePlaygroundOperation | null>(null);

  useEffect(() => {
    return () => {
      activeRequestRef.current += 1;
      clientRef.current?.dispose();
    };
  }, []);

  const cancel = useCallback(() => {
    activeRequestRef.current += 1;
    clientRef.current?.dispose();
    setActiveOperation(null);
  }, []);

  const request = async <Result>(
    operation: KitePlaygroundOperation,
    execute: (client: KitePlaygroundClient) => Promise<Result>,
  ): Promise<KitePlaygroundRequestOutcome<Result>> => {
    const client = (clientRef.current ??= new KitePlaygroundClient());
    const requestId = ++activeRequestRef.current;
    setActiveOperation(operation);

    const finish = (
      outcome: KitePlaygroundRequestOutcome<Result>,
    ): KitePlaygroundRequestOutcome<Result> => {
      // Only the newest request owns the operation flag; a superseded request
      // resolving late must not clear newer state.
      if (requestId === activeRequestRef.current) {
        setActiveOperation(null);
      }
      return requestId === activeRequestRef.current ? outcome : { kind: "superseded" };
    };

    try {
      return finish({ kind: "result", result: await execute(client) });
    } catch (error) {
      if (error instanceof KitePlaygroundServiceError) {
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

  const run = (files: readonly KitePlaygroundFile[]): Promise<KitePlaygroundRunOutcome> =>
    request("run", (client) => client.run({ files }));

  const format = (files: readonly KitePlaygroundFile[]): Promise<KitePlaygroundFormatOutcome> =>
    request("format", (client) => client.format({ files }));

  return {
    isRunning: activeOperation === "run",
    isFormatting: activeOperation === "format",
    run,
    format,
    cancel,
  };
}

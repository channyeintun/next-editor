import { useCallback, useEffect, useRef, useState } from "react";
import {
  AsmPlaygroundClient,
  AsmPlaygroundServiceError,
  type AsmPlaygroundServiceErrorKind,
} from "../runtime/asmPlayground/client";
import type { AsmPlaygroundFile, AsmPlaygroundRunResult } from "../runtime/asmPlayground/types";

type AsmPlaygroundRequestOutcome<Result> =
  | { kind: "result"; result: Result }
  | {
      kind: "service-error";
      errorKind: Exclude<AsmPlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer run (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

export type AsmPlaygroundRunOutcome = AsmPlaygroundRequestOutcome<AsmPlaygroundRunResult>;

/**
 * Explicit assembly-run orchestration for lessons, mirroring
 * useKitePlaygroundRunner. Owns one AsmPlaygroundClient so a newer Run
 * supersedes the one before it, and unmounting (route change, switching lesson
 * types) discards whatever is left.
 *
 * The difference from the four proxied languages: there is no service behind
 * this, so "cancel" is a generation bump rather than an aborted request, and an
 * assembly lesson can never be unauthenticated or rate limited. The difference
 * from Kite: there is not even a compiler to load, so the first run costs the
 * same as every later one.
 */
export function useAsmPlaygroundRunner() {
  const clientRef = useRef<AsmPlaygroundClient | null>(null);
  const activeRequestRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    return () => {
      activeRequestRef.current += 1;
      clientRef.current?.dispose();
    };
  }, []);

  const cancel = useCallback(() => {
    activeRequestRef.current += 1;
    clientRef.current?.dispose();
    setIsRunning(false);
  }, []);

  const run = async (
    files: readonly AsmPlaygroundFile[],
    stdin?: string,
  ): Promise<AsmPlaygroundRunOutcome> => {
    const client = (clientRef.current ??= new AsmPlaygroundClient());
    const requestId = ++activeRequestRef.current;
    setIsRunning(true);

    const finish = (outcome: AsmPlaygroundRunOutcome): AsmPlaygroundRunOutcome => {
      // Only the newest request owns the running flag; a superseded request
      // resolving late must not clear newer state.
      if (requestId === activeRequestRef.current) {
        setIsRunning(false);
      }
      return requestId === activeRequestRef.current ? outcome : { kind: "superseded" };
    };

    try {
      return finish({ kind: "result", result: await client.run({ files, stdin }) });
    } catch (error) {
      if (error instanceof AsmPlaygroundServiceError) {
        if (error.kind === "aborted") {
          return { kind: "superseded" };
        }
        return finish({ kind: "service-error", errorKind: error.kind, message: error.message });
      }
      return finish({
        kind: "service-error",
        errorKind: "unavailable",
        message: error instanceof Error ? error.message : "The run failed",
      });
    }
  };

  return { isRunning, run, cancel };
}

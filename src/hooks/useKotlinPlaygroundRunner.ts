import { useCallback, useEffect, useRef, useState } from "react";
import {
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceError,
  type KotlinPlaygroundServiceErrorKind,
} from "../runtime/kotlinPlayground/client";
import type {
  KotlinPlaygroundFile,
  KotlinPlaygroundRunResult,
} from "../runtime/kotlinPlayground/types";

export type KotlinPlaygroundRunOutcome =
  | { kind: "result"; result: KotlinPlaygroundRunResult }
  | {
      kind: "service-error";
      errorKind: Exclude<KotlinPlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer run (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

/**
 * Explicit Kotlin run orchestration for lessons. Owns one
 * KotlinPlaygroundClient so a newer Run aborts the in-flight request, and
 * unmounting (route change, switching lesson types) aborts whatever is left —
 * nothing here ever calls the service from lesson load or playback. Unlike Go
 * there is no Format operation: upstream exposes no formatter.
 */
export function useKotlinPlaygroundRunner() {
  const clientRef = useRef<KotlinPlaygroundClient | null>(null);
  const activeRequestRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    return () => {
      activeRequestRef.current += 1;
      clientRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    activeRequestRef.current += 1;
    clientRef.current?.abort();
    setIsRunning(false);
  }, []);

  const run = async (
    files: readonly KotlinPlaygroundFile[],
  ): Promise<KotlinPlaygroundRunOutcome> => {
    const client = (clientRef.current ??= new KotlinPlaygroundClient());
    const requestId = ++activeRequestRef.current;
    setIsRunning(true);

    const finish = (outcome: KotlinPlaygroundRunOutcome): KotlinPlaygroundRunOutcome => {
      // Only the newest request owns the running flag; a superseded request
      // resolving late (the client already aborted it) must not clear newer state.
      if (requestId === activeRequestRef.current) {
        setIsRunning(false);
        return outcome;
      }
      return { kind: "superseded" };
    };

    try {
      return finish({ kind: "result", result: await client.run(files) });
    } catch (error) {
      if (error instanceof KotlinPlaygroundServiceError) {
        if (error.kind === "aborted") {
          return { kind: "superseded" };
        }
        return finish({ kind: "service-error", errorKind: error.kind, message: error.message });
      }
      return finish({
        kind: "service-error",
        errorKind: "unavailable",
        message: error instanceof Error ? error.message : "The run request failed",
      });
    }
  };

  return { isRunning, run, cancel };
}

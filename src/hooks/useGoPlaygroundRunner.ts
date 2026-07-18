import { useEffect, useRef, useState } from "react";
import {
  GoPlaygroundClient,
  GoPlaygroundServiceError,
  type GoPlaygroundServiceErrorKind,
} from "../runtime/goPlayground/client";
import type { GoPlaygroundRunResult } from "../runtime/goPlayground/types";

export type GoPlaygroundRunOutcome =
  | { kind: "result"; result: GoPlaygroundRunResult }
  | {
      kind: "service-error";
      errorKind: Exclude<GoPlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer run (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

export interface GoPlaygroundRunnerState {
  isRunning: boolean;
}

/**
 * Explicit-Run orchestration for Go lessons. Owns one GoPlaygroundClient so a
 * repeated Run aborts the in-flight request, and unmounting (route change,
 * switching lesson types) aborts whatever is left — nothing here ever runs
 * from lesson load or playback.
 */
export function useGoPlaygroundRunner() {
  const clientRef = useRef<GoPlaygroundClient | null>(null);
  const activeRunRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    return () => {
      activeRunRef.current += 1;
      clientRef.current?.abort();
    };
  }, []);

  const run = async (source: string): Promise<GoPlaygroundRunOutcome> => {
    const client = (clientRef.current ??= new GoPlaygroundClient());
    const runId = ++activeRunRef.current;
    setIsRunning(true);

    const finish = (outcome: GoPlaygroundRunOutcome): GoPlaygroundRunOutcome => {
      // Only the newest run owns the running flag; a superseded run resolving
      // late (client.run already aborted it) must not clear the newer state.
      if (runId === activeRunRef.current) {
        setIsRunning(false);
      }
      return runId === activeRunRef.current ? outcome : { kind: "superseded" };
    };

    try {
      return finish({ kind: "result", result: await client.run(source) });
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
        message: error instanceof Error ? error.message : "The run request failed",
      });
    }
  };

  return { isRunning, run };
}

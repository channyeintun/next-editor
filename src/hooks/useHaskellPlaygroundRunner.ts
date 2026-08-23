import { useCallback, useEffect, useRef, useState } from "react";
import {
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceError,
  type HaskellPlaygroundServiceErrorKind,
} from "../runtime/haskellPlayground/client";
import type {
  HaskellPlaygroundFile,
  HaskellPlaygroundRunResult,
} from "../runtime/haskellPlayground/types";

export type HaskellPlaygroundRunOutcome =
  | { kind: "result"; result: HaskellPlaygroundRunResult }
  | {
      kind: "service-error";
      errorKind: Exclude<HaskellPlaygroundServiceErrorKind, "aborted">;
      message: string;
    }
  /** A newer run (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

/**
 * Explicit Haskell run orchestration for lessons, mirroring
 * useKotlinPlaygroundRunner. Owns one HaskellPlaygroundClient so a newer Run
 * aborts the in-flight request, and unmounting (route change, switching lesson
 * types) aborts whatever is left — nothing here ever calls the service from
 * lesson load or playback. Like Kotlin and unlike Zig there is no Format
 * operation: play.haskell.org exposes a single /submit route and no formatter
 * endpoint at all, so this hook has exactly one operation to track.
 */
export function useHaskellPlaygroundRunner() {
  const clientRef = useRef<HaskellPlaygroundClient | null>(null);
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
    files: readonly HaskellPlaygroundFile[],
  ): Promise<HaskellPlaygroundRunOutcome> => {
    const client = (clientRef.current ??= new HaskellPlaygroundClient());
    const requestId = ++activeRequestRef.current;
    setIsRunning(true);

    const finish = (outcome: HaskellPlaygroundRunOutcome): HaskellPlaygroundRunOutcome => {
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
      if (error instanceof HaskellPlaygroundServiceError) {
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

import { useEffect, useRef, useState } from "react";
import { arePlaygroundFilesEqual, type PlaygroundFile } from "../runtime/playgroundFiles";
import type { PlaygroundClientBinding } from "../runtime/playgroundLanguage";

/** How one playground request ended, as a runner panel renders it. */
export type PlaygroundRequestOutcome<Result, ErrorKind extends string> =
  | { kind: "result"; result: Result }
  | {
      kind: "service-error";
      errorKind: Exclude<ErrorKind, "aborted"> | "unavailable";
      message: string;
    }
  /**
   * A newer operation, a repeat that joined this one, or unmount took over; the caller must
   * render nothing.
   */
  | { kind: "superseded" };

/** What a caller may tell a request beyond its operation. */
export interface PlaygroundRequestOptions {
  /**
   * The sources the request submits, given only where the same operation on equal sources is
   * the same request. Such a request joins the one in flight instead of superseding it: for a
   * proxied language the Worker has already spent a rate-limit slot and an upstream call on
   * that one, so aborting it to send the same files again would spend both twice for the same
   * answer.
   */
  files?: readonly PlaygroundFile[];
  /** Called when the request really starts, so never for one that joins the request in flight. */
  onStart?: () => void;
}

/** The request in flight, kept only while its caller named the sources it submits. */
interface JoinableRequest<Operation> {
  operation: Operation;
  files: readonly PlaygroundFile[];
  execution: Promise<unknown>;
}

/**
 * Explicit Run/Format orchestration for a playground lesson. Owns one client, so a newer
 * operation supersedes the one in flight, and unmounting (route change, switching lesson types)
 * stops whatever is left — nothing here ever calls a tool from lesson load or playback.
 * `activeOperation` belongs to the newest request only: a superseded request that resolves late
 * reports "superseded" and leaves the newer state alone.
 *
 * A repeat of the request in flight (same operation, equal `files`) starts nothing: it takes
 * over reporting that request's outcome, and the earlier caller reads "superseded", so the
 * outcome is rendered once, by the newest caller, as with any other newer request.
 *
 * `binding` must be a module-level constant: it is read once per call and never re-subscribed.
 */
export function usePlaygroundRunner<Client, Operation extends string, ErrorKind extends string>(
  binding: PlaygroundClientBinding<Client, ErrorKind>,
) {
  const clientRef = useRef<Client | null>(null);
  const activeRequestRef = useRef(0);
  const joinableRef = useRef<JoinableRequest<Operation> | null>(null);
  const [activeOperation, setActiveOperation] = useState<Operation | null>(null);

  useEffect(() => {
    return () => {
      activeRequestRef.current += 1;
      joinableRef.current = null;
      if (clientRef.current) binding.stop(clientRef.current);
    };
  }, [binding]);

  const cancel = () => {
    activeRequestRef.current += 1;
    // A stopped request may never settle (an in-page run is abandoned, not rejected), so
    // nothing may join it.
    joinableRef.current = null;
    if (clientRef.current) binding.stop(clientRef.current);
    setActiveOperation(null);
  };

  const request = async <Result>(
    operation: Operation,
    execute: (client: Client) => Promise<Result>,
    { files, onStart }: PlaygroundRequestOptions = {},
  ): Promise<PlaygroundRequestOutcome<Result, ErrorKind>> => {
    const joinable = joinableRef.current;
    let execution: Promise<Result>;
    if (
      files &&
      joinable?.operation === operation &&
      arePlaygroundFilesEqual(joinable.files, files)
    ) {
      // The same operation on the same sources was started with the same execute, so its
      // execution resolves with this request's Result.
      execution = joinable.execution as Promise<Result>;
    } else {
      onStart?.();
      if (!clientRef.current) {
        clientRef.current = binding.create();
      }
      const client = clientRef.current;
      // Async, so an execute that throws before returning its promise rejects like one that
      // fails later, and every caller handles it in the same catch below.
      const started = (async () => execute(client))();
      joinableRef.current = files ? { operation, files, execution: started } : null;
      // Registered before any caller awaits it, so a settled request is no longer in flight by
      // the time its outcome renders: the next Run on the same sources starts anew.
      const forget = () => {
        if (joinableRef.current?.execution === started) {
          joinableRef.current = null;
        }
      };
      void started.then(forget, forget);
      execution = started;
    }
    const requestId = ++activeRequestRef.current;
    setActiveOperation(operation);

    const finish = (
      outcome: PlaygroundRequestOutcome<Result, ErrorKind>,
    ): PlaygroundRequestOutcome<Result, ErrorKind> => {
      if (requestId !== activeRequestRef.current) {
        return { kind: "superseded" };
      }
      setActiveOperation(null);
      return outcome;
    };

    try {
      return finish({ kind: "result", result: await execution });
    } catch (error) {
      if (error instanceof binding.ServiceError) {
        // The client aborts a request only when a newer one or cancel took over.
        if (error.kind === "aborted") {
          return { kind: "superseded" };
        }
        return finish({
          kind: "service-error",
          errorKind: error.kind as Exclude<ErrorKind, "aborted">,
          message: error.message,
        });
      }
      return finish({
        kind: "service-error",
        errorKind: "unavailable",
        message: error instanceof Error ? error.message : `The ${operation} failed`,
      });
    }
  };

  return { activeOperation, request, cancel };
}

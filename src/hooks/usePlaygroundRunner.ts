import { useCallback, useEffect, useRef, useState } from "react";

/** How one playground request ended, as a runner panel renders it. */
export type PlaygroundRequestOutcome<Result, ErrorKind extends string> =
  | { kind: "result"; result: Result }
  | {
      kind: "service-error";
      errorKind: Exclude<ErrorKind, "aborted"> | "unavailable";
      message: string;
    }
  /** A newer operation (or unmount) took over; the caller must render nothing. */
  | { kind: "superseded" };

/** A runtime client's typed error: every playground client throws one of these. */
type PlaygroundServiceErrorClass<ErrorKind extends string> = abstract new (
  kind: ErrorKind,
  message: string,
) => Error & { readonly kind: ErrorKind };

export interface PlaygroundClientBinding<Client, ErrorKind extends string> {
  create: () => Client;
  /**
   * Ends whatever the client is doing: aborts the service request of a proxied language, or
   * disposes the in-page compiler of Kite and assembly (where cancelling is only a generation
   * bump, since there is no request to abort).
   */
  stop: (client: Client) => void;
  /** Its errors carry their own kind; anything else it throws is reported as "unavailable". */
  ServiceError: PlaygroundServiceErrorClass<ErrorKind>;
}

/**
 * Explicit Run/Format orchestration for a playground lesson. Owns one client, so a newer
 * operation supersedes the one in flight, and unmounting (route change, switching lesson types)
 * stops whatever is left — nothing here ever calls a tool from lesson load or playback.
 * `activeOperation` belongs to the newest request only: a superseded request that resolves late
 * reports "superseded" and leaves the newer state alone.
 *
 * `binding` must be a module-level constant: it is read once per call and never re-subscribed.
 */
export function usePlaygroundRunner<Client, Operation extends string, ErrorKind extends string>(
  binding: PlaygroundClientBinding<Client, ErrorKind>,
) {
  const clientRef = useRef<Client | null>(null);
  const activeRequestRef = useRef(0);
  const [activeOperation, setActiveOperation] = useState<Operation | null>(null);

  useEffect(() => {
    return () => {
      activeRequestRef.current += 1;
      if (clientRef.current) binding.stop(clientRef.current);
    };
  }, [binding]);

  const cancel = useCallback(() => {
    activeRequestRef.current += 1;
    if (clientRef.current) binding.stop(clientRef.current);
    setActiveOperation(null);
  }, [binding]);

  const request = async <Result>(
    operation: Operation,
    execute: (client: Client) => Promise<Result>,
  ): Promise<PlaygroundRequestOutcome<Result, ErrorKind>> => {
    if (!clientRef.current) {
      clientRef.current = binding.create();
    }
    const client = clientRef.current;
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
      return finish({ kind: "result", result: await execute(client) });
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

// The errors the `net` domain raises, shaped as Node's: `connect ECONNREFUSED
// 127.0.0.1:3000`, `listen EADDRINUSE: address already in use :::3000`,
// `read ECONNRESET`, with `code`, `errno`, `syscall`, `address` and `port`. Also
// the platform's own timers, captured at load so a socket timeout never goes
// through (or keeps alive) the process's `timers` module. Their callbacks are
// macrotasks (eventLoop.ts `runMacrotask`), as a Node timer's is: the ticks a
// 'timeout' listener queues run before its promise jobs.
import {
  errnoOf,
  systemErrorFromRecord,
  systemErrorMessage,
  type ErrnoCode,
  type SystemError,
} from "../../../errors";
import { makeNodeError } from "../internalErrors";
import { runMacrotask } from "../eventLoop";

function description(code: ErrnoCode): string {
  const message = systemErrorMessage({ code, syscall: "" });
  return message.slice(code.length + 2, message.lastIndexOf(","));
}

function withMessage(error: SystemError, message: string): SystemError {
  error.message = message;
  if (typeof error.stack === "string") {
    const newline = error.stack.indexOf("\n");
    error.stack = `Error: ${message}${newline === -1 ? "" : error.stack.slice(newline)}`;
  }
  return error;
}

/** `connect ECONNREFUSED 127.0.0.1:3000`: Node's `ExceptionWithHostPort`. */
export function exceptionWithHostPort(
  code: ErrnoCode,
  syscall: string,
  address: string,
  port?: number,
  additional?: string,
): SystemError {
  const error = systemErrorFromRecord({ code, syscall, address, port });
  let details = port !== undefined && port > 0 ? `${address}:${port}` : address;
  if (additional) {
    details += ` - ${additional}`;
  }
  return withMessage(error, `${syscall} ${code} ${details}`);
}

/**
 * How Node fails a connect by name whose attempt a second connect by name
 * cancelled: each lookup starts its own attempt on a fresh handle (Node's
 * autoSelectFamily), the second closes the first's, and the first gives up
 * with Node's `NodeAggregateError` of the one failure, `code` ECANCELED and
 * an empty message.
 */
export function connectCanceled(address: string, port: number): Error {
  const error = new AggregateError(
    [exceptionWithHostPort("ECANCELED", "connect", address, port)],
    "",
  ) as AggregateError & { code: string };
  error.code = "ECANCELED";
  return error;
}

/** `listen EADDRINUSE: address already in use :::3000`: Node's `UVExceptionWithHostPort`. */
export function uvExceptionWithHostPort(
  code: ErrnoCode,
  syscall: string,
  address: string,
  port: number,
): SystemError {
  const error = systemErrorFromRecord({ code, syscall, address, port });
  return withMessage(error, `${syscall} ${code}: ${description(code)} ${address}:${port}`);
}

/** `read ECONNRESET`: Node's `ErrnoException`. */
export function errnoException(code: ErrnoCode, syscall: string): SystemError {
  return withMessage(systemErrorFromRecord({ code, syscall }), `${syscall} ${code}`);
}

/** Node's `ConnResetException`: an `ECONNRESET` error with a plain message (`socket hang up`, `aborted`). */
export function connResetException(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "ECONNRESET";
  return error;
}

/** `EPIPE` for a write after the peer ended, as Node words it. */
export function writeAfterFinError(): Error & { code: string; errno: number; syscall?: string } {
  const error = new Error("This socket has been ended by the other party") as Error & {
    code: string;
    errno: number;
  };
  error.code = "EPIPE";
  error.errno = -errnoOf("EPIPE");
  return error;
}

/** `ERR_SOCKET_CLOSED`. */
export function socketClosedError(): Error {
  return makeNodeError("ERR_SOCKET_CLOSED", "Socket is closed", Error);
}

/** A webnode limit: an `Error` with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` naming what is missing. */
export function unsupported(what: string, why: string): Error {
  return makeNodeError(
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `${what} is not supported in webnode: ${why}`,
    Error,
  );
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const platformSetTimeout = globalThis.setTimeout.bind(globalThis);
const platformClearTimeout = globalThis.clearTimeout.bind(globalThis);
const platformSetInterval = globalThis.setInterval.bind(globalThis);
const platformClearInterval = globalThis.clearInterval.bind(globalThis);

function unrefHandle(handle: TimerHandle): TimerHandle {
  // Under Node (the tests) a timer would hold the event loop open; in a
  // browser the handle is a number and there is nothing to release.
  (handle as unknown as { unref?: () => void }).unref?.();
  return handle;
}

/** The platform's `setTimeout`, never keeping a Node test process alive; `callback` runs as a macrotask. */
export function startTimer(callback: () => void, ms: number): TimerHandle {
  return unrefHandle(platformSetTimeout(() => runMacrotask(callback), ms));
}

/** Clears a timer from `startTimer`. */
export function stopTimer(handle: TimerHandle | null): void {
  if (handle !== null) {
    platformClearTimeout(handle);
  }
}

/** The platform's `setInterval`, never keeping a Node test process alive; each run of `callback` is a macrotask. */
export function startInterval(callback: () => void, ms: number): TimerHandle {
  return unrefHandle(platformSetInterval(() => runMacrotask(callback), ms));
}

/** Clears an interval from `startInterval`. */
export function stopInterval(handle: TimerHandle | null): void {
  if (handle !== null) {
    platformClearInterval(handle);
  }
}

/** A handle from `startTimer` / `startInterval`. */
export type { TimerHandle };

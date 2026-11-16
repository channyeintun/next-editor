// The `inspector` builtin. There is no V8 inspector a page can attach to, so
// the inspector is never active: `url()` is undefined, `close()` and the
// `Network` notifications do nothing, and opening, waiting or connecting a
// `Session` throws a named error. `console` is the global console.
import EventEmitter from "./events";
import { makeNodeError } from "./internalErrors";

function unavailable(name: string): Error {
  return makeNodeError(
    "ERR_INSPECTOR_NOT_AVAILABLE",
    `inspector.${name} is not available in webnode`,
  );
}

/** `inspector.open([port[, host[, wait]]])`: throws (no inspector). */
export function open(_port?: number, _host?: string, _wait?: boolean): never {
  throw unavailable("open");
}

/** `inspector.close()`: nothing is open, so nothing to do. */
export function close(): void {}

/** `inspector.url()`: undefined, as when no inspector is active. */
export function url(): string | undefined {
  return undefined;
}

/** `inspector.waitForDebugger()`: throws `ERR_INSPECTOR_NOT_ACTIVE`, as Node does without an active inspector. */
export function waitForDebugger(): never {
  throw makeNodeError("ERR_INSPECTOR_NOT_ACTIVE", "Inspector is not active");
}

/** `inspector.Session`: can be created; connecting throws. */
export class Session extends EventEmitter {
  connect(): never {
    throw unavailable("Session.connect");
  }

  connectToMainThread(): never {
    throw unavailable("Session.connectToMainThread");
  }

  post(_method: string, _params?: unknown, _callback?: unknown): never {
    throw makeNodeError("ERR_INSPECTOR_NOT_CONNECTED", "Session is not connected");
  }

  disconnect(): void {}
}

/** `inspector.Network`: the notifications go nowhere, since no frontend is attached. */
export const Network = Object.freeze({
  requestWillBeSent(_params: unknown): void {},
  responseReceived(_params: unknown): void {},
  loadingFinished(_params: unknown): void {},
  loadingFailed(_params: unknown): void {},
});

/** `inspector.console`: the global console (there is no inspector console to forward to). */
export const console = globalThis.console;

const inspector = { open, close, url, waitForDebugger, console, Session, Network };

export default inspector;

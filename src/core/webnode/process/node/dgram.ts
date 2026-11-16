// The `dgram` builtin. A browser has no UDP, so sockets cannot be created; the
// module exists so imports succeed and fail only when a socket is made.
import EventEmitter from "./events";
import { makeNodeError } from "./internalErrors";

function unavailable(name: string): Error {
  return makeNodeError(
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `dgram.${name} is not available in webnode`,
  );
}

/** `dgram.Socket`: constructing one throws (no UDP in a browser). */
export class Socket extends EventEmitter {
  constructor() {
    super();
    throw unavailable("Socket");
  }
}

/** `dgram.createSocket(type[, listener])`: throws (no UDP in a browser). */
export function createSocket(_type?: unknown, _listener?: unknown): never {
  throw unavailable("createSocket");
}

const dgram = { createSocket, Socket };

export default dgram;

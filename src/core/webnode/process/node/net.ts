// The `net` builtin. Sockets and servers ride the kernel's in-runtime network
// (`runtime().net`): a connection to this machine is a `ByteChannel`; raw TCP
// to any other host does not exist in a browser and fails with `ENETUNREACH`.
// The classes live in net/ (socket, server, ip); this file assembles the module.
import { validateBoolean, validateInteger } from "./internalErrors";
import { BlockList, isIP, isIPv4, isIPv6, SocketAddress } from "./net/ip";
import { Server, type ServerOptions } from "./net/server";
import { normalizeArgs, Socket, type SocketOptions } from "./net/socket";

export { BlockList, isIP, isIPv4, isIPv6, Server, Socket, SocketAddress };
export type { AddressInfo, ListenOptions, ServerOptions } from "./net/server";
export type { SocketConnectOptions, SocketOptions } from "./net/socket";

/** `net.createServer([options][, connectionListener])`. */
export function createServer(
  options?: ServerOptions | ((socket: Socket) => void),
  connectionListener?: (socket: Socket) => void,
): Server {
  return new Server(options, connectionListener);
}

/** `net.connect(...)` / `net.createConnection(...)`: a new `Socket`, connecting. */
export function connect(...args: unknown[]): Socket {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  const socket = new Socket(options as SocketOptions);
  if (options.timeout) {
    socket.setTimeout(options.timeout);
  }
  return socket.connect(normalized);
}

/** Alias of `connect`. */
export const createConnection = connect;

let autoSelectFamilyDefault = true;
let autoSelectFamilyAttemptTimeoutDefault = 250;

/** `net.getDefaultAutoSelectFamily()`. */
export function getDefaultAutoSelectFamily(): boolean {
  return autoSelectFamilyDefault;
}

/** `net.setDefaultAutoSelectFamily(value)`. */
export function setDefaultAutoSelectFamily(value: boolean): void {
  validateBoolean(value, "value");
  autoSelectFamilyDefault = value;
}

/** `net.getDefaultAutoSelectFamilyAttemptTimeout()`. */
export function getDefaultAutoSelectFamilyAttemptTimeout(): number {
  return autoSelectFamilyAttemptTimeoutDefault;
}

/** `net.setDefaultAutoSelectFamilyAttemptTimeout(value)`: at least 10 ms. */
export function setDefaultAutoSelectFamilyAttemptTimeout(value: number): void {
  validateInteger(value, "value", 1, 2 ** 31 - 1);
  autoSelectFamilyAttemptTimeoutDefault = value < 10 ? 10 : value;
}

/** What `require("net")` returns. */
const net = {
  _normalizeArgs: normalizeArgs,
  BlockList,
  SocketAddress,
  connect,
  createConnection,
  createServer,
  isIP,
  isIPv4,
  isIPv6,
  Server,
  Socket,
  Stream: Socket,
  getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
};

export default net;

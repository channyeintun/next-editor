// The `http` builtin: an HTTP/1.1 server and client over webnode's in-runtime
// network (net), with requests to other hosts carried by `fetch`. The parts
// live in http/ (common, incoming, outgoing, response, server, agent, client,
// fetchExchange); this file assembles the module.
import { validateInteger } from "./internalErrors";
import { Agent, getGlobalAgent, globalAgent, setGlobalAgent } from "./http/agent";
import { ClientRequest, type RequestOptions } from "./http/client";
import {
  checkInvalidHeaderChar,
  checkIsHttpToken,
  MAX_HEADER_SIZE,
  METHODS,
  STATUS_CODES,
  validateHeaderName,
  validateHeaderValue,
} from "./http/common";
import { IncomingMessage } from "./http/incoming";
import { OutgoingMessage } from "./http/outgoing";
import { ServerResponse } from "./http/response";
import { _connectionListener, Server, type HttpServerOptions } from "./http/server";

export {
  Agent,
  ClientRequest,
  globalAgent,
  IncomingMessage,
  METHODS,
  OutgoingMessage,
  Server,
  ServerResponse,
  STATUS_CODES,
  validateHeaderName,
  validateHeaderValue,
};
export type { AgentOptions } from "./http/agent";
export type { RequestOptions } from "./http/client";
export type { HttpServerOptions } from "./http/server";

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
type ResponseListener = (res: IncomingMessage) => void;

/** `http.createServer([options][, requestListener])`. */
export function createServer(
  options?: HttpServerOptions | RequestListener,
  requestListener?: RequestListener,
): Server {
  return new Server(options, requestListener);
}

/** `http.request(url[, options][, callback])` / `http.request(options[, callback])`. */
export function request(
  url: string | URL | RequestOptions,
  options?: RequestOptions | ResponseListener,
  callback?: ResponseListener,
): ClientRequest {
  return new ClientRequest(url, options, callback);
}

/** `http.get(...)`: `request` with the request already ended. */
export function get(
  url: string | URL | RequestOptions,
  options?: RequestOptions | ResponseListener,
  callback?: ResponseListener,
): ClientRequest {
  const req = request(url, options, callback);
  req.end();
  return req;
}

/** `http.isValidHeaderName(name)`. */
export function isValidHeaderName(name: unknown): boolean {
  return typeof name === "string" && name.length > 0 && checkIsHttpToken(name);
}

/** `http.isValidHeaderValue(value)`. */
export function isValidHeaderValue(value: unknown): boolean {
  return value !== undefined && !checkInvalidHeaderChar(value);
}

/** `http.setMaxIdleHTTPParsers(max)`: parsers are not pooled here, so only the argument is checked. */
export function setMaxIdleHTTPParsers(max: number): void {
  validateInteger(max, "max", 1);
}

/** `http.maxHeaderSize`. */
export const maxHeaderSize = MAX_HEADER_SIZE;

/** What `require("http")` returns. */
const http = {
  _connectionListener,
  METHODS: [...METHODS],
  STATUS_CODES,
  Agent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  Server,
  ServerResponse,
  createServer,
  isValidHeaderName,
  isValidHeaderValue,
  validateHeaderName,
  validateHeaderValue,
  get,
  request,
  setMaxIdleHTTPParsers,
  maxHeaderSize,
  globalAgent,
  WebSocket: undefined as unknown,
  CloseEvent: undefined as unknown,
  MessageEvent: undefined as unknown,
};

Object.defineProperty(http, "globalAgent", {
  configurable: true,
  enumerable: true,
  get: getGlobalAgent,
  set: setGlobalAgent,
});

// The platform's own WebSocket classes, read when asked for (as Node's lazy getters).
for (const name of ["WebSocket", "CloseEvent", "MessageEvent"] as const) {
  Object.defineProperty(http, name, {
    configurable: true,
    enumerable: true,
    get: () => (globalThis as Record<string, unknown>)[name],
  });
}

export default http;

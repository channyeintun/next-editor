// `http.Server`: a `net.Server` whose connections are parsed as HTTP/1.1
// requests (keep-alive, pipelined requests answered in order, `Expect:
// 100-continue`, `upgrade`/`connect` hand-over of the raw socket,
// `clientError`), with Node's server timeouts. Ported from Node 22's
// lib/_http_server.js onto `HttpParser` (http-parser-js).
import { Buffer } from "../buffer";
import { captureRejectionSymbol } from "../events";
import { outOfRange, validateBoolean, validateInteger, validateObject } from "../internalErrors";
import { connResetException, startInterval, stopInterval, type TimerHandle } from "../net/errors";
import { Server as NetServer } from "../net/server";
import type { Socket } from "../net/socket";
import { nextTick } from "../eventLoop";
import {
  codedError,
  continueExpression,
  HttpParser,
  MAX_HEADER_PAIRS,
  MAX_HEADER_SIZE,
  STATUS_CODES,
  type ParsedHead,
} from "./common";
import { IncomingMessage, readStart, readStop, type HttpSocket } from "./incoming";
import { kNeedDrain, kUniqueHeaders, parseUniqueHeadersOption } from "./outgoing";
import { emitResponseClose, ServerResponse } from "./response";

/** `http.createServer(options)`. */
export interface HttpServerOptions {
  IncomingMessage?: typeof IncomingMessage;
  ServerResponse?: typeof ServerResponse;
  maxHeaderSize?: number;
  insecureHTTPParser?: boolean;
  requestTimeout?: number;
  headersTimeout?: number;
  keepAliveTimeout?: number;
  connectionsCheckingInterval?: number;
  requireHostHeader?: boolean;
  joinDuplicateHeaders?: boolean;
  rejectNonStandardBodyWrites?: boolean;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  highWaterMark?: number;
  uniqueHeaders?: unknown[];
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

const kIncomingMessage = Symbol("IncomingMessage");
const kServerResponse = Symbol("ServerResponse");
const kConnections = Symbol("http.server.connections");
const kCheckingInterval = Symbol("http.server.connectionsCheckingInterval");
const HTTP_SERVER_KEEP_ALIVE_TIMEOUT_BUFFER = 1000;

const badRequestResponse = Buffer.from(
  `HTTP/1.1 400 ${STATUS_CODES[400]}\r\nConnection: close\r\n\r\n`,
  "ascii",
);
const requestTimeoutResponse = Buffer.from(
  `HTTP/1.1 408 ${STATUS_CODES[408]}\r\nConnection: close\r\n\r\n`,
  "ascii",
);
const requestHeaderFieldsTooLargeResponse = Buffer.from(
  `HTTP/1.1 431 ${STATUS_CODES[431]}\r\nConnection: close\r\n\r\n`,
  "ascii",
);

/** Everything the server keeps per connection. */
interface Connection {
  socket: HttpSocket;
  parser: HttpParser | null;
  /** The request being parsed, or the last one parsed. */
  incoming: IncomingMessage | null;
  trailers: string[];
  outgoing: ServerResponse[];
  pending: IncomingMessage[];
  outgoingData: number;
  requestsCount: number;
  keepAliveTimeoutSet: boolean;
  /** When the message being parsed began (0: between messages); for the request timeouts. */
  messageStart: number;
  headersCompleted: boolean;
  onData: (chunk: Buffer) => void;
  onEnd: () => void;
  onClose: () => void;
  onDrain: () => void;
  onError: (error: Error & { code?: string }) => void;
  onTimeout: () => void;
}

const noop = () => {};

/** `http.Server`. TLS is never terminated here: `https.Server` is this same server. */
export class Server extends NetServer {
  timeout = 0;
  maxHeadersCount: number | null = null;
  maxRequestsPerSocket = 0;
  httpAllowHalfOpen = false;
  maxHeaderSize: number | undefined;
  insecureHTTPParser: boolean | undefined;
  requestTimeout: number;
  headersTimeout: number;
  keepAliveTimeout: number;
  connectionsCheckingInterval: number;
  requireHostHeader: boolean;
  joinDuplicateHeaders: boolean | undefined;
  rejectNonStandardBodyWrites: boolean;
  [kIncomingMessage]: typeof IncomingMessage;
  [kServerResponse]: typeof ServerResponse;
  [kUniqueHeaders]: Set<string> | null;
  [kConnections] = new Map<HttpSocket, Connection>();
  [kCheckingInterval]: TimerHandle | null = null;

  constructor(
    options?: HttpServerOptions | RequestListener | null,
    requestListener?: RequestListener,
  ) {
    let opts: HttpServerOptions;
    let listener = requestListener;
    if (typeof options === "function") {
      listener = options;
      opts = {};
    } else if (options == null) {
      opts = {};
    } else {
      validateObject(options, "options");
      opts = options;
    }
    super({
      allowHalfOpen: true,
      noDelay: opts.noDelay ?? true,
      keepAlive: opts.keepAlive,
      keepAliveInitialDelay: opts.keepAliveInitialDelay,
      highWaterMark: opts.highWaterMark,
    });
    this[kIncomingMessage] = opts.IncomingMessage || IncomingMessage;
    this[kServerResponse] = opts.ServerResponse || ServerResponse;
    if (opts.maxHeaderSize !== undefined) {
      validateInteger(opts.maxHeaderSize, "maxHeaderSize", 0);
    }
    this.maxHeaderSize = opts.maxHeaderSize;
    if (opts.insecureHTTPParser !== undefined) {
      validateBoolean(opts.insecureHTTPParser, "options.insecureHTTPParser");
    }
    this.insecureHTTPParser = opts.insecureHTTPParser;
    if (opts.requestTimeout !== undefined) {
      validateInteger(opts.requestTimeout, "requestTimeout", 0);
      this.requestTimeout = opts.requestTimeout;
    } else {
      this.requestTimeout = 300_000;
    }
    if (opts.headersTimeout !== undefined) {
      validateInteger(opts.headersTimeout, "headersTimeout", 0);
      this.headersTimeout = opts.headersTimeout;
    } else {
      this.headersTimeout = Math.min(60_000, this.requestTimeout);
    }
    if (
      this.requestTimeout > 0 &&
      this.headersTimeout > 0 &&
      this.headersTimeout > this.requestTimeout
    ) {
      throw outOfRange("headersTimeout", "<= requestTimeout", opts.headersTimeout);
    }
    if (opts.keepAliveTimeout !== undefined) {
      validateInteger(opts.keepAliveTimeout, "keepAliveTimeout", 0);
      this.keepAliveTimeout = opts.keepAliveTimeout;
    } else {
      this.keepAliveTimeout = 5_000;
    }
    if (opts.connectionsCheckingInterval !== undefined) {
      validateInteger(opts.connectionsCheckingInterval, "connectionsCheckingInterval", 0);
      this.connectionsCheckingInterval = opts.connectionsCheckingInterval;
    } else {
      this.connectionsCheckingInterval = 30_000;
    }
    if (opts.requireHostHeader !== undefined) {
      validateBoolean(opts.requireHostHeader, "options.requireHostHeader");
      this.requireHostHeader = opts.requireHostHeader;
    } else {
      this.requireHostHeader = true;
    }
    if (opts.joinDuplicateHeaders !== undefined) {
      validateBoolean(opts.joinDuplicateHeaders, "options.joinDuplicateHeaders");
    }
    this.joinDuplicateHeaders = opts.joinDuplicateHeaders;
    if (opts.rejectNonStandardBodyWrites !== undefined) {
      validateBoolean(opts.rejectNonStandardBodyWrites, "options.rejectNonStandardBodyWrites");
      this.rejectNonStandardBodyWrites = opts.rejectNonStandardBodyWrites;
    } else {
      this.rejectNonStandardBodyWrites = false;
    }
    this[kUniqueHeaders] = parseUniqueHeadersOption(opts.uniqueHeaders);
    if (listener) {
      this.on("request", listener);
    }
    this.on("connection", (socket: Socket) => connectionListener(this, socket as HttpSocket));
    this.on("listening", () => this.#setupConnectionsTracking());
  }

  #setupConnectionsTracking(): void {
    stopInterval(this[kCheckingInterval]);
    this[kCheckingInterval] =
      this.connectionsCheckingInterval > 0
        ? startInterval(() => checkConnections(this), this.connectionsCheckingInterval)
        : null;
  }

  /** Stops listening and closes idle connections; `close` follows once the busy ones end. */
  override close(cb?: (error?: Error) => void): this {
    this.closeIdleConnections();
    stopInterval(this[kCheckingInterval]);
    this[kCheckingInterval] = null;
    super.close(cb);
    return this;
  }

  /** Destroys every connection, busy or not. */
  closeAllConnections(): void {
    for (const socket of Array.from(this[kConnections].keys())) {
      socket.destroy();
    }
  }

  /** Destroys the connections with no request in flight. */
  closeIdleConnections(): void {
    for (const [socket, connection] of Array.from(this[kConnections])) {
      if (connection.messageStart !== 0) {
        continue;
      }
      const message = socket._httpMessage as ServerResponse | null;
      if (message && !message.finished) {
        continue;
      }
      socket.destroy();
    }
  }

  /** Sets the socket idle timeout for new connections. */
  setTimeout(msecs: number, callback?: (socket: Socket) => void): this {
    this.timeout = msecs;
    if (callback) {
      this.on("timeout", callback);
    }
    return this;
  }
}

Object.defineProperty(Server.prototype, captureRejectionSymbol, {
  configurable: true,
  writable: true,
  value: function onRejection(this: Server, error: Error, event: string, ...args: unknown[]) {
    if (event === "request") {
      const res = args[1] as ServerResponse;
      if (!res.headersSent && !res.writableEnded) {
        for (const name of res.getHeaderNames()) {
          res.removeHeader(name);
        }
        res.statusCode = 500;
        res.end(STATUS_CODES[500]);
      } else {
        res.destroy();
      }
      return;
    }
    this.emit("error", error);
  },
});

function checkConnections(server: Server): void {
  const { headersTimeout, requestTimeout } = server;
  if (headersTimeout === 0 && requestTimeout === 0) {
    return;
  }
  const now = Date.now();
  for (const connection of Array.from(server[kConnections].values())) {
    if (connection.messageStart === 0) {
      continue;
    }
    const elapsed = now - connection.messageStart;
    if (
      (headersTimeout > 0 && !connection.headersCompleted && elapsed > headersTimeout) ||
      (requestTimeout > 0 && elapsed > requestTimeout)
    ) {
      connection.messageStart = 0;
      connection.onError(codedError("ERR_HTTP_REQUEST_TIMEOUT", "Request timeout"));
    }
  }
}

function socketSetEncoding(): never {
  throw codedError(
    "ERR_HTTP_SOCKET_ENCODING",
    "Changing the socket encoding is not allowed per RFC7230 Section 3.",
  );
}

function connectionListener(server: Server, socket: HttpSocket): void {
  socket.server = server;
  if (server.timeout) {
    socket.setTimeout(server.timeout);
  }
  const connection: Connection = {
    socket,
    parser: null,
    incoming: null,
    trailers: [],
    outgoing: [],
    pending: [],
    outgoingData: 0,
    requestsCount: 0,
    keepAliveTimeoutSet: false,
    messageStart: 0,
    headersCompleted: false,
    onData: (chunk) => socketOnData(server, connection, chunk),
    onEnd: () => socketOnEnd(server, connection),
    onClose: () => socketOnClose(server, connection),
    onDrain: () => socketOnDrain(connection),
    onError: (error) => socketOnError(server, connection, error),
    onTimeout: () => socketOnTimeout(server, connection),
  };
  const maxHeaderPairs =
    typeof server.maxHeadersCount === "number" ? server.maxHeadersCount << 1 : MAX_HEADER_PAIRS;
  connection.parser = new HttpParser(
    "REQUEST",
    {
      onHeadersComplete: (head) =>
        parserOnHeadersComplete(server, connection, head, maxHeaderPairs),
      onBody: (chunk) => {
        const stream = connection.incoming;
        if (stream === null || stream._dumped) {
          return;
        }
        if (!stream.push(chunk)) {
          readStop(socket);
        }
      },
      onTrailers: (trailers) => {
        connection.trailers.push(...trailers);
      },
      onMessageComplete: () => {
        const stream = connection.incoming;
        connection.messageStart = 0;
        if (stream !== null) {
          stream.complete = true;
          if (connection.trailers.length) {
            stream._addHeaderLines(connection.trailers, connection.trailers.length);
            connection.trailers = [];
          }
          stream.push(null);
        }
        readStart(socket);
      },
    },
    server.maxHeaderSize || MAX_HEADER_SIZE,
    server.insecureHTTPParser === true,
  );
  socket.parser = connection.parser;
  server[kConnections].set(socket, connection);
  socket.on("timeout", connection.onTimeout);
  socket.on("data", connection.onData);
  socket.on("error", connection.onError);
  socket.on("end", connection.onEnd);
  socket.on("close", connection.onClose);
  socket.on("drain", connection.onDrain);
  socket.on("resume", onSocketResume);
  socket.setEncoding = socketSetEncoding;
  socket._paused = false;
}

function onSocketResume(this: HttpSocket): void {
  if (this._paused) {
    this.pause();
  }
}

function parserOnHeadersComplete(
  server: Server,
  connection: Connection,
  head: ParsedHead,
  maxHeaderPairs: number,
): number {
  const { socket } = connection;
  const Incoming = server[kIncomingMessage];
  const req = new Incoming(socket);
  connection.incoming = req;
  connection.headersCompleted = true;
  req.httpVersionMajor = head.versionMajor;
  req.httpVersionMinor = head.versionMinor;
  req.httpVersion = `${head.versionMajor}.${head.versionMinor}`;
  req.joinDuplicateHeaders = Boolean(server.joinDuplicateHeaders);
  req.url = head.url;
  req.upgrade = head.upgrade;
  let n = head.headers.length;
  if (maxHeaderPairs > 0) {
    n = Math.min(n, maxHeaderPairs);
  }
  req._addHeaderLines(head.headers.slice(0, n), n);
  req.method = head.method;
  return parserOnIncoming(server, connection, req, head.shouldKeepAlive);
}

function socketOnData(server: Server, connection: Connection, chunk: Buffer): void {
  const parser = connection.parser;
  if (parser === null) {
    return;
  }
  if (connection.messageStart === 0) {
    connection.messageStart = Date.now();
    connection.headersCompleted = false;
  }
  let data = chunk;
  for (;;) {
    const ret = parser.execute(data);
    onParserExecuteCommon(server, connection, ret, data);
    // The JS parser stops after any head that announced an upgrade; when the
    // server declined it, the bytes after it are ordinary pipelined requests.
    if (
      ret instanceof Error ||
      ret >= data.length ||
      connection.parser !== parser ||
      connection.incoming?.upgrade
    ) {
      return;
    }
    data = data.subarray(ret);
  }
}

function onParserExecuteCommon(
  server: Server,
  connection: Connection,
  ret: number | Error,
  chunk: Buffer,
): void {
  const { socket } = connection;
  resetSocketTimeout(server, connection);
  if (ret instanceof Error) {
    (ret as Error & { rawPacket?: Buffer }).rawPacket = chunk;
    connection.onError(ret);
    return;
  }
  const req = connection.incoming;
  if (req?.upgrade) {
    socket.removeListener("data", connection.onData);
    socket.removeListener("end", connection.onEnd);
    socket.removeListener("close", connection.onClose);
    socket.removeListener("drain", connection.onDrain);
    socket.removeListener("error", connection.onError);
    socket.removeListener("timeout", connection.onTimeout);
    socket.removeListener("resume", onSocketResume);
    // The socket now belongs to the upgrade handler: server.close() and the
    // idle/timeout checks leave it alone, as Node's freed parser does.
    server[kConnections].delete(socket);
    connection.parser = null;
    socket.parser = null;
    connection.messageStart = 0;
    const eventName = req.method === "CONNECT" ? "connect" : "upgrade";
    if (eventName === "upgrade" || server.listenerCount(eventName) > 0) {
      const bodyHead = chunk.subarray(ret, chunk.length);
      (socket as unknown as { readableFlowing: boolean | null }).readableFlowing = null;
      server.emit(eventName, req, socket, Buffer.from(bodyHead));
    } else {
      socket.destroy();
    }
  }
}

function socketOnEnd(server: Server, connection: Connection): void {
  const { socket } = connection;
  const ret = connection.parser?.finish();
  if (ret instanceof Error) {
    connection.onError(ret);
  } else if (!server.httpAllowHalfOpen) {
    socket.end();
  } else if (connection.outgoing.length) {
    connection.outgoing[connection.outgoing.length - 1]._last = true;
  } else if (socket._httpMessage) {
    (socket._httpMessage as ServerResponse)._last = true;
  } else {
    socket.end();
  }
}

function socketOnClose(server: Server, connection: Connection): void {
  connection.parser = null;
  connection.socket.parser = null;
  server[kConnections].delete(connection.socket);
  const pending = connection.pending;
  while (pending.length) {
    const req = pending.shift() as IncomingMessage;
    req.destroy(connResetException("aborted"));
  }
}

function socketOnDrain(connection: Connection): void {
  const { socket } = connection;
  const needPause = connection.outgoingData > socket.writableHighWaterMark;
  if (socket._paused && !needPause) {
    socket._paused = false;
    socket.resume();
  }
  const message = socket._httpMessage as ServerResponse | null;
  if (message && !message.finished && message[kNeedDrain]) {
    message[kNeedDrain] = false;
    message.emit("drain");
  }
}

function socketOnTimeout(server: Server, connection: Connection): void {
  const { socket } = connection;
  const req = connection.incoming;
  const reqTimeout = req !== null && !req.complete && req.emit("timeout", socket);
  const res = socket._httpMessage as ServerResponse | null;
  const resTimeout = res !== null && res.emit("timeout", socket);
  const serverTimeout = server.emit("timeout", socket);
  if (!reqTimeout && !resTimeout && !serverTimeout) {
    socket.destroy();
  }
}

function socketOnError(
  server: Server,
  connection: Connection,
  error: Error & { code?: string },
): void {
  const { socket } = connection;
  socket.removeListener("error", connection.onError);
  if (!socket.listeners("error").includes(noop)) {
    socket.on("error", noop);
  }
  // A peer that drops an idle connection (the preview gateway closes each one
  // after its response) is not a client error worth reporting.
  if (
    error.code === "ECONNRESET" &&
    connection.messageStart === 0 &&
    connection.pending.length === 0 &&
    !socket._httpMessage
  ) {
    socket.destroy();
    return;
  }
  if (!server.emit("clientError", error, socket)) {
    const message = socket._httpMessage as ServerResponse | null;
    if (socket.writable && (!message || !message._headerSent)) {
      let response: Buffer;
      switch (error.code) {
        case "HPE_HEADER_OVERFLOW":
          response = requestHeaderFieldsTooLargeResponse;
          break;
        case "ERR_HTTP_REQUEST_TIMEOUT":
          response = requestTimeoutResponse;
          break;
        default:
          response = badRequestResponse;
          break;
      }
      socket.write(response);
    }
    socket.destroy(error);
  }
}

function resetSocketTimeout(server: Server, connection: Connection): void {
  if (!connection.keepAliveTimeoutSet) {
    return;
  }
  connection.socket.setTimeout(server.timeout || 0);
  connection.keepAliveTimeoutSet = false;
}

function updateOutgoingData(connection: Connection, delta: number): void {
  connection.outgoingData += delta;
  socketOnDrain(connection);
}

function clearIncoming(connection: Connection, req: IncomingMessage): void {
  if (connection.incoming === req) {
    if (req.readableEnded) {
      connection.incoming = null;
    } else {
      req.once("end", () => clearIncoming(connection, req));
    }
  }
}

function resOnFinish(
  server: Server,
  connection: Connection,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { socket } = connection;
  if (connection.pending[0] === req) {
    connection.pending.shift();
  }
  // Nobody read the body: drain it so the connection can carry the next request.
  const state = (req as unknown as { _readableState: { resumeScheduled: boolean } })._readableState;
  if (!req._consuming && !state.resumeScheduled) {
    req._dump();
  }
  res.detachSocket(socket);
  clearIncoming(connection, req);
  nextTick(() => emitResponseClose(res));
  if (res._last) {
    socket.destroySoon();
  } else if (connection.outgoing.length === 0) {
    if (server.keepAliveTimeout) {
      socket.setTimeout(server.keepAliveTimeout + HTTP_SERVER_KEEP_ALIVE_TIMEOUT_BUFFER);
      connection.keepAliveTimeoutSet = true;
    }
  } else {
    const next = connection.outgoing.shift();
    next?.assignSocket(socket);
  }
}

function parserOnIncoming(
  server: Server,
  connection: Connection,
  req: IncomingMessage,
  keepAlive: boolean,
): number {
  const { socket } = connection;
  resetSocketTimeout(server, connection);
  if (req.upgrade) {
    req.upgrade = req.method === "CONNECT" || server.listenerCount("upgrade") > 0;
    if (req.upgrade) {
      return 2;
    }
  }
  connection.pending.push(req);
  if (!socket._paused) {
    const needDrain = (socket as unknown as { _writableState: { needDrain: boolean } })
      ._writableState.needDrain;
    if (needDrain || connection.outgoingData >= socket.writableHighWaterMark) {
      socket._paused = true;
      socket.pause();
    }
  }
  const Response = server[kServerResponse];
  const res = new Response(req, {
    highWaterMark: socket.writableHighWaterMark,
    rejectNonStandardBodyWrites: server.rejectNonStandardBodyWrites,
  });
  res._keepAliveTimeout = server.keepAliveTimeout;
  res._maxRequestsPerSocket = server.maxRequestsPerSocket;
  res._onPendingData = (delta) => updateOutgoingData(connection, delta);
  res.shouldKeepAlive = keepAlive;
  res[kUniqueHeaders] = server[kUniqueHeaders];
  if (socket._httpMessage) {
    connection.outgoing.push(res);
  } else {
    res.assignSocket(socket);
  }
  res.on("finish", () => resOnFinish(server, connection, req, res));
  let handled = false;
  if (req.httpVersionMajor === 1 && req.httpVersionMinor === 1) {
    if (server.requireHostHeader && req.headers.host === undefined) {
      res.writeHead(400, ["Connection", "close"]);
      res.end();
      return 0;
    }
    const isRequestsLimitSet =
      typeof server.maxRequestsPerSocket === "number" && server.maxRequestsPerSocket > 0;
    if (isRequestsLimitSet) {
      connection.requestsCount++;
      res.maxRequestsOnConnectionReached = server.maxRequestsPerSocket <= connection.requestsCount;
    }
    if (isRequestsLimitSet && server.maxRequestsPerSocket < connection.requestsCount) {
      handled = true;
      server.emit("dropRequest", req, socket);
      res.writeHead(503);
      res.end();
    } else if (req.headers.expect !== undefined) {
      handled = true;
      if (continueExpression.test(String(req.headers.expect))) {
        res._expect_continue = true;
        if (server.listenerCount("checkContinue") > 0) {
          server.emit("checkContinue", req, res);
        } else {
          res.writeContinue();
          server.emit("request", req, res);
        }
      } else if (server.listenerCount("checkExpectation") > 0) {
        server.emit("checkExpectation", req, res);
      } else {
        res.writeHead(417);
        res.end();
      }
    }
  }
  if (!handled) {
    server.emit("request", req, res);
  }
  return 0;
}

/** The server's connection handler, as `http._connectionListener`. */
export function _connectionListener(this: Server, socket: Socket): void {
  connectionListener(this, socket as HttpSocket);
}

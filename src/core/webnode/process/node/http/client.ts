// `http.ClientRequest`. A request to this machine goes over a `net` socket as
// real HTTP/1.1 (through an `Agent`, parsed with `HttpParser`), ported from
// Node 22's lib/_http_client.js. A request to any other host cannot open a
// socket in a browser: it is carried by `fetch` (http/fetchExchange.ts) behind
// a stand-in socket, with the same events in the same order.
import { Buffer } from "../buffer";
import {
  AbortError,
  invalidArgType,
  makeNodeError,
  validateBoolean,
  validateInteger,
} from "../internalErrors";
import { connect as netConnect } from "../net";
import { nextTick } from "../eventLoop";
import { connResetException, unsupported } from "../net/errors";
import { isLocalHost } from "../net/ip";
import { timerDuration, type Socket } from "../net/socket";
import { finished } from "../stream";
import { urlToHttpOptions } from "../url";
import { getGlobalAgent, type Agent, type AgentConnectionOptions } from "./agent";
import {
  checkIsHttpToken,
  headersSent,
  HttpParser,
  invalidHttpToken,
  MAX_HEADER_PAIRS,
  MAX_HEADER_SIZE,
  type ParsedHead,
} from "./common";
import { FetchExchange } from "./fetchExchange";
import { IncomingMessage, readStart, readStop, type HttpSocket } from "./incoming";
import {
  kNeedDrain,
  kOutHeaders,
  kUniqueHeaders,
  OutgoingMessage,
  parseUniqueHeadersOption,
  type OutgoingHeaderValue,
} from "./outgoing";

/** `http.request(options)`. */
export interface RequestOptions {
  protocol?: string | null;
  host?: string | null;
  hostname?: string | null;
  family?: number;
  port?: number | string | null;
  defaultPort?: number;
  localAddress?: string;
  socketPath?: string;
  method?: string;
  path?: string | null;
  headers?: Record<string, OutgoingHeaderValue> | readonly string[] | readonly [string, string][];
  auth?: string | null;
  agent?: Agent | boolean | null;
  _defaultAgent?: Agent;
  timeout?: number;
  setHost?: boolean;
  setDefaultHeaders?: boolean;
  createConnection?: (
    options: RequestOptions,
    callback: (error: Error | null, socket?: Socket) => void,
  ) => Socket | undefined | null;
  maxHeaderSize?: number;
  insecureHTTPParser?: boolean;
  joinDuplicateHeaders?: boolean;
  uniqueHeaders?: unknown[];
  signal?: AbortSignal;
  lookup?: unknown;
  [key: string]: unknown;
}

type ResponseListener = (res: IncomingMessage) => void;

const INVALID_PATH_REGEX = /[^!-ÿ]/;
const kError = Symbol("kError");
/** The `fetch` exchange carrying a request to another host; null for a local request. */
export const kFetch = Symbol("kFetch");

/** The parser a client socket carries while a response is due. */
interface ClientParserState {
  parser: HttpParser;
  incoming: IncomingMessage | null;
  trailers: string[];
}

function isURL(value: unknown): value is URL {
  if (value instanceof URL) {
    return true;
  }
  const candidate = value as {
    href?: unknown;
    protocol?: unknown;
    auth?: unknown;
    path?: unknown;
  } | null;
  return Boolean(
    candidate?.href &&
    candidate.protocol &&
    candidate.auth === undefined &&
    candidate.path === undefined,
  );
}

function validateHost(host: unknown, name: string): string | null | undefined {
  if (host !== null && host !== undefined && typeof host !== "string") {
    throw invalidArgType(`options.${name}`, ["string", "undefined", "null"], host);
  }
  return host;
}

function statusIsInformational(status: number | null): boolean {
  return status !== null && status < 200 && status >= 100 && status !== 101;
}

/** `http.ClientRequest`. */
export class ClientRequest extends OutgoingMessage {
  declare agent: Agent | undefined;
  socketPath: string | undefined;
  timeout: number | undefined;
  method: string;
  maxHeaderSize: number | undefined;
  insecureHTTPParser: boolean | undefined;
  joinDuplicateHeaders: boolean | undefined;
  path: string;
  _ended = false;
  res: IncomingMessage | null = null;
  aborted = false;
  timeoutCb: (() => void) | null = null;
  upgradeOrConnect = false;
  parser: HttpParser | null = null;
  maxHeadersCount: number | null = null;
  reusedSocket = false;
  host: string;
  protocol: string;
  [kError]: Error | undefined = undefined;
  [kFetch]: FetchExchange | null = null;

  constructor(
    input: string | URL | RequestOptions,
    options?: RequestOptions | ResponseListener,
    cb?: ResponseListener,
  ) {
    super();
    let base: RequestOptions | null;
    let opts: RequestOptions;
    let callback = cb;
    if (typeof input === "string") {
      base = urlToHttpOptions(new URL(input)) as unknown as RequestOptions;
    } else if (isURL(input)) {
      base = urlToHttpOptions(input) as unknown as RequestOptions;
    } else {
      callback = options as ResponseListener | undefined;
      options = input;
      base = null;
    }
    if (typeof options === "function") {
      callback = options;
      opts = base || {};
    } else {
      opts = Object.assign(base || {}, options);
    }

    let agent = opts.agent;
    const defaultAgent = opts._defaultAgent || getGlobalAgent();
    if (agent === false) {
      const AgentClass = defaultAgent.constructor as new () => Agent;
      agent = new AgentClass();
    } else if (agent === null || agent === undefined) {
      if (typeof opts.createConnection !== "function") {
        agent = defaultAgent;
      }
    } else if (typeof (agent as { addRequest?: unknown }).addRequest !== "function") {
      throw invalidArgType("options.agent", ["Agent-like Object", "undefined", "false"], agent);
    }
    this.agent = (agent || undefined) as Agent | undefined;

    const protocol = opts.protocol || defaultAgent.protocol;
    let expectedProtocol = defaultAgent.protocol;
    if (this.agent?.protocol) {
      expectedProtocol = this.agent.protocol;
    }
    if (opts.path) {
      const path = String(opts.path);
      if (INVALID_PATH_REGEX.test(path)) {
        throw makeNodeError<TypeError>(
          "ERR_UNESCAPED_CHARACTERS",
          "Request path contains unescaped characters",
          TypeError,
        );
      }
    }
    if (protocol !== expectedProtocol) {
      throw makeNodeError<TypeError>(
        "ERR_INVALID_PROTOCOL",
        `Protocol "${protocol}" not supported. Expected "${expectedProtocol}"`,
        TypeError,
      );
    }
    const defaultPort = opts.defaultPort || this.agent?.defaultPort;
    const optsWithoutSignal: RequestOptions = { ...opts };
    const port = (optsWithoutSignal.port = opts.port || defaultPort || 80);
    const host = (optsWithoutSignal.host =
      validateHost(opts.hostname, "hostname") || validateHost(opts.host, "host") || "localhost");
    const setHost =
      opts.setHost !== undefined ? Boolean(opts.setHost) : opts.setDefaultHeaders !== false;
    this._removedConnection = opts.setDefaultHeaders === false;
    this._removedContLen = opts.setDefaultHeaders === false;
    this._removedTE = opts.setDefaultHeaders === false;
    this.socketPath = opts.socketPath;
    if (opts.timeout !== undefined) {
      this.timeout = timerDuration(opts.timeout, "timeout");
    }
    const signal = opts.signal;
    if (signal) {
      addAbortSignal(signal, this);
      delete optsWithoutSignal.signal;
    }
    let method = opts.method;
    const methodIsString = typeof method === "string";
    if (method !== null && method !== undefined && !methodIsString) {
      throw invalidArgType("options.method", "string", method);
    }
    if (methodIsString && method) {
      if (!checkIsHttpToken(method)) {
        throw invalidHttpToken("Method", method);
      }
      method = this.method = method.toUpperCase();
    } else {
      method = this.method = "GET";
    }
    if (opts.maxHeaderSize !== undefined) {
      validateInteger(opts.maxHeaderSize, "maxHeaderSize", 0);
    }
    this.maxHeaderSize = opts.maxHeaderSize;
    if (opts.insecureHTTPParser !== undefined) {
      validateBoolean(opts.insecureHTTPParser, "options.insecureHTTPParser");
    }
    this.insecureHTTPParser = opts.insecureHTTPParser;
    if (opts.joinDuplicateHeaders !== undefined) {
      validateBoolean(opts.joinDuplicateHeaders, "options.joinDuplicateHeaders");
    }
    this.joinDuplicateHeaders = opts.joinDuplicateHeaders;
    this.path = opts.path || "/";
    if (callback) {
      this.once("response", callback);
    }
    this.useChunkedEncodingByDefault = !(
      method === "GET" ||
      method === "HEAD" ||
      method === "DELETE" ||
      method === "OPTIONS" ||
      method === "TRACE" ||
      method === "CONNECT"
    );
    this.host = host;
    this.protocol = protocol;

    const local = isLocalHost(host);
    if (opts.socketPath) {
      throw unsupported(
        `http.request({ socketPath: ${JSON.stringify(opts.socketPath)} })`,
        "there are no Unix domain sockets",
      );
    }
    if (!local) {
      // No socket reaches another host from a browser: fetch carries the request.
      this[kFetch] = new FetchExchange(
        this,
        `${protocol}//${this.#authority(host, port, defaultPort)}${this.path}`,
        (socket, res) => parserOnIncomingClient(socket, res, false),
      );
    }
    if (this.agent && local) {
      if (!this.agent.keepAlive && !Number.isFinite(this.agent.maxSockets)) {
        this._last = true;
        this.shouldKeepAlive = false;
      } else {
        this._last = false;
        this.shouldKeepAlive = true;
      }
    }

    const headersArray = Array.isArray(opts.headers);
    if (!headersArray) {
      if (opts.headers) {
        const headers = opts.headers as Record<string, OutgoingHeaderValue>;
        for (const key of Object.keys(headers)) {
          this.setHeader(key, headers[key]);
        }
      }
      if (host && !this.getHeader("host") && setHost) {
        let hostHeader = host;
        const posColon = hostHeader.indexOf(":");
        if (
          posColon !== -1 &&
          hostHeader.includes(":", posColon + 1) &&
          hostHeader.charCodeAt(0) !== 91
        ) {
          hostHeader = `[${hostHeader}]`;
        }
        if (port && +port !== defaultPort) {
          hostHeader += `:${port}`;
        }
        this.setHeader("Host", hostHeader);
      }
      if (opts.auth && !this.getHeader("Authorization")) {
        this.setHeader("Authorization", `Basic ${Buffer.from(opts.auth).toString("base64")}`);
      }
      if (this.getHeader("expect")) {
        if (this._header) {
          throw headersSent("render");
        }
        this._storeHeader(`${this.method} ${this.path} HTTP/1.1\r\n`, this[kOutHeaders]);
      }
    } else {
      this._storeHeader(`${this.method} ${this.path} HTTP/1.1\r\n`, opts.headers);
    }
    this[kUniqueHeaders] = parseUniqueHeadersOption(opts.uniqueHeaders);

    const exchange = this[kFetch];
    if (exchange) {
      this._last = true;
      this.shouldKeepAlive = false;
      this.onSocket(exchange.socket);
      return;
    }
    if (this.agent) {
      this.agent.addRequest(this, optsWithoutSignal as AgentConnectionOptions);
      return;
    }
    this._last = true;
    this.shouldKeepAlive = false;
    const connectOptions: RequestOptions = { ...optsWithoutSignal };
    if (connectOptions.path) {
      connectOptions.path = undefined;
    }
    if (typeof connectOptions.createConnection === "function") {
      let called = false;
      const oncreate = (error: Error | null, socket?: Socket) => {
        if (called) {
          return;
        }
        called = true;
        if (error) {
          nextTick(() => this.emit("error", error));
        } else if (socket) {
          this.onSocket(socket as HttpSocket);
        }
      };
      try {
        const created = connectOptions.createConnection(connectOptions, oncreate);
        if (created) {
          oncreate(null, created);
        }
      } catch (error) {
        oncreate(error as Error);
      }
    } else {
      this.onSocket(netConnect(connectOptions) as HttpSocket);
    }
  }

  #authority(host: string, port: number | string, defaultPort: number | undefined): string {
    const name = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return port && +port !== (defaultPort ?? (this.protocol === "https:" ? 443 : 80))
      ? `${name}:${port}`
      : name;
  }

  override _implicitHeader(): void {
    if (this._header) {
      throw headersSent("render");
    }
    this._storeHeader(`${this.method} ${this.path} HTTP/1.1\r\n`, this[kOutHeaders]);
  }

  override _storeHeader(firstLine: string, headers: unknown): void {
    super._storeHeader(firstLine, headers);
    if (this[kFetch]) {
      // fetch frames the body itself.
      this.chunkedEncoding = false;
    }
  }

  override _send(
    data: string | Uint8Array,
    encoding?: BufferEncoding | null,
    callback?: ((error?: Error | null) => void) | null,
    byteLength?: number,
  ): boolean {
    const exchange = this[kFetch];
    if (exchange) {
      this._headerSent = true;
      return exchange.write(data, encoding, callback);
    }
    return super._send(data, encoding, callback, byteLength);
  }

  override end(
    chunk?: string | Uint8Array | ((error?: Error | null) => void) | null,
    encoding?: BufferEncoding | ((error?: Error | null) => void) | null,
    callback?: (error?: Error | null) => void,
  ): this {
    super.end(chunk, encoding, callback);
    this[kFetch]?.endBody();
    return this;
  }

  /** Aborts the request (deprecated in Node; use `destroy`). Emits `abort`. */
  abort(): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    nextTick(() => this.emit("abort"));
    this.destroy();
  }

  /** Destroys the request and its socket; `error` follows unless it was aborted before connecting. */
  override destroy(error?: Error): this {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;
    if (this.res) {
      this.res._dump();
    }
    this[kError] = error;
    this[kFetch]?.cancel();
    this.socket?.destroy(error);
    return this;
  }

  /** Hands the request its socket on the next tick. */
  onSocket(socket: HttpSocket, error?: Error): void {
    nextTick(() => onSocketNT(this, socket, error));
  }

  _deferToConnect(method: "setNoDelay" | "setKeepAlive" | null, args: unknown[]): void {
    const callSocketMethod = () => {
      if (method && this.socket) {
        (this.socket[method] as (...a: unknown[]) => unknown)(...args);
      }
    };
    const onSocket = () => {
      if (this.socket?.writable) {
        callSocketMethod();
      } else {
        this.socket?.once("connect", callSocketMethod);
      }
    };
    if (!this.socket) {
      this.once("socket", onSocket);
    } else {
      onSocket();
    }
  }

  /** `timeout` fires after `msecs` without socket activity. */
  override setTimeout(msecs: number, callback?: () => void): this {
    if (this._ended) {
      return this;
    }
    listenSocketTimeout(this);
    const duration = timerDuration(msecs, "msecs");
    if (callback) {
      this.once("timeout", callback);
    }
    if (this.socket) {
      setSocketTimeout(this.socket, duration);
    } else {
      this.once("socket", (socket: HttpSocket) => setSocketTimeout(socket, duration));
    }
    return this;
  }

  setNoDelay(noDelay?: boolean): void {
    this._deferToConnect("setNoDelay", [noDelay]);
  }

  setSocketKeepAlive(enable?: boolean, initialDelay?: number): void {
    this._deferToConnect("setKeepAlive", [enable, initialDelay]);
  }

  clearTimeout(callback?: () => void): void {
    this.setTimeout(0, callback);
  }
}

function addAbortSignal(signal: AbortSignal, req: ClientRequest): void {
  if (typeof signal !== "object" || signal === null || !("aborted" in signal)) {
    throw invalidArgType("signal", "AbortSignal", signal);
  }
  const onAbort = () => {
    req.destroy(new AbortError(undefined, { cause: signal.reason }));
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
    req.once("close", () => signal.removeEventListener("abort", onAbort));
  }
}

function setSocketTimeout(socket: HttpSocket, msecs: number): void {
  if (socket.connecting) {
    socket.once("connect", () => socket.setTimeout(msecs));
  } else {
    socket.setTimeout(msecs);
  }
}

function emitRequestTimeout(this: HttpSocket): void {
  const req = this._httpMessage as ClientRequest | null;
  req?.emit("timeout");
}

function listenSocketTimeout(req: ClientRequest): void {
  if (req.timeoutCb) {
    return;
  }
  req.timeoutCb = emitRequestTimeout;
  if (req.socket) {
    req.socket.once("timeout", emitRequestTimeout);
  } else {
    req.on("socket", (socket: HttpSocket) => {
      socket.once("timeout", emitRequestTimeout);
    });
  }
}

function onSocketNT(req: ClientRequest, socket: HttpSocket | undefined, error?: Error): void {
  if (req.destroyed || error) {
    req.destroyed = true;
    const destroyRequest = (failure: Error | null | undefined) => {
      let reported = failure;
      if (!req.aborted && !reported) {
        reported = connResetException("socket hang up");
      }
      if (reported) {
        req.emit("error", reported);
      }
      req._closed = true;
      req.emit("close");
    };
    if (socket) {
      if (!error && req.agent && !socket.destroyed && !req[kFetch]) {
        socket.emit("free");
      } else {
        socket.destroy(error || req[kError]);
        finished(socket, (failure) => {
          let reported: Error | null | undefined = failure;
          if (
            (failure as { code?: string } | null | undefined)?.code === "ERR_STREAM_PREMATURE_CLOSE"
          ) {
            reported = null;
          }
          destroyRequest(reported || error);
        });
        return;
      }
    }
    destroyRequest(error || req[kError]);
    return;
  }
  tickOnSocket(req, socket as HttpSocket);
  req._flush();
}

function tickOnSocket(req: ClientRequest, socket: HttpSocket): void {
  req.socket = socket;
  socket._httpMessage = req;
  socket.on("error", socketErrorListener);
  socket.on("close", socketCloseListener);
  const exchange = req[kFetch];
  if (exchange) {
    if (req.timeout !== undefined) {
      listenSocketTimeout(req);
      socket.setTimeout(req.timeout);
    }
    req.emit("socket", socket);
    exchange.start();
    return;
  }
  const maxHeaderPairs =
    typeof req.maxHeadersCount === "number" ? req.maxHeadersCount << 1 : MAX_HEADER_PAIRS;
  const state: ClientParserState = {
    parser: null as unknown as HttpParser,
    incoming: null,
    trailers: [],
  };
  state.parser = new HttpParser(
    "RESPONSE",
    {
      onHeadersComplete: (head) => clientOnHeadersComplete(socket, state, head, maxHeaderPairs),
      onBody: (chunk) => {
        const stream = state.incoming;
        if (stream === null || stream._dumped) {
          return;
        }
        if (!stream.push(chunk)) {
          readStop(socket);
        }
      },
      onTrailers: (trailers) => {
        state.trailers.push(...trailers);
      },
      onMessageComplete: () => {
        const stream = state.incoming;
        if (stream !== null) {
          stream.complete = true;
          if (state.trailers.length) {
            stream._addHeaderLines(state.trailers, state.trailers.length);
            state.trailers = [];
          }
          stream.push(null);
        }
        readStart(socket);
      },
    },
    req.maxHeaderSize || MAX_HEADER_SIZE,
    req.insecureHTTPParser === true,
  );
  req.parser = state.parser;
  socket.parser = state;
  socket.on("data", socketOnData);
  socket.on("end", socketOnEnd);
  socket.on("drain", ondrain);
  if (
    req.timeout !== undefined ||
    (req.agent?.options as { timeout?: number } | undefined)?.timeout
  ) {
    listenSocketTimeout(req);
  }
  req.emit("socket", socket);
}

function freeParser(req: ClientRequest | null, socket: HttpSocket): void {
  if (req) {
    req.parser = null;
  }
  socket.parser = null;
}

function clientOnHeadersComplete(
  socket: HttpSocket,
  state: ClientParserState,
  head: ParsedHead,
  maxHeaderPairs: number,
): number {
  const req = socket._httpMessage as ClientRequest;
  const res = new IncomingMessage(socket);
  state.incoming = res;
  res.httpVersionMajor = head.versionMajor;
  res.httpVersionMinor = head.versionMinor;
  res.httpVersion = `${head.versionMajor}.${head.versionMinor}`;
  res.joinDuplicateHeaders = Boolean(req.joinDuplicateHeaders);
  res.upgrade = head.upgrade;
  let n = head.headers.length;
  if (maxHeaderPairs > 0) {
    n = Math.min(n, maxHeaderPairs);
  }
  res._addHeaderLines(head.headers.slice(0, n), n);
  res.statusCode = head.statusCode;
  res.statusMessage = head.statusMessage;
  return parserOnIncomingClient(socket, res, head.shouldKeepAlive);
}

/** Wires a response to its request; returns 0, 1 (skip the body) or 2 (upgrade). */
export function parserOnIncomingClient(
  socket: HttpSocket,
  res: IncomingMessage,
  shouldKeepAlive: boolean,
): number {
  const req = socket._httpMessage as ClientRequest;
  if (req.res) {
    // A second response on one request: the server is broken.
    socket.destroy();
    return 0;
  }
  req.res = res;
  if (res.upgrade) {
    return 2;
  }
  const method = req.method;
  if (method === "CONNECT") {
    res.upgrade = true;
    return 2;
  }
  if (statusIsInformational(res.statusCode)) {
    req.res = null;
    if (res.statusCode === 100) {
      req.emit("continue");
    }
    req.emit("information", {
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      httpVersion: res.httpVersion,
      httpVersionMajor: res.httpVersionMajor,
      httpVersionMinor: res.httpVersionMinor,
      headers: res.headers,
      rawHeaders: res.rawHeaders,
    });
    return 1;
  }
  if (req.shouldKeepAlive && !shouldKeepAlive && !req.upgradeOrConnect) {
    req.shouldKeepAlive = false;
  }
  req.res = res;
  res.req = req;
  res.on("end", responseOnEnd);
  req.on("finish", requestOnFinish);
  socket.on("timeout", responseOnTimeout);
  if (req.aborted || !req.emit("response", res)) {
    res._dump();
  }
  if (method === "HEAD") {
    return 1;
  }
  if (res.statusCode === 304) {
    res.complete = true;
    return 1;
  }
  return 0;
}

function socketOnData(this: HttpSocket, chunk: Buffer): void {
  handleSocketData(this, chunk);
}

function handleSocketData(socket: HttpSocket, chunk: Buffer): void {
  const req = socket._httpMessage as ClientRequest;
  const state = socket.parser as ClientParserState | null;
  if (state === null) {
    return;
  }
  const ret = state.parser.execute(chunk);
  if (ret instanceof Error) {
    (ret as Error & { rawPacket?: Buffer }).rawPacket = chunk;
    freeParser(req, socket);
    socket.removeListener("data", socketOnData);
    socket.removeListener("end", socketOnEnd);
    socket.destroy();
    socket._hadError = true;
    req.emit("error", ret);
  } else if (state.incoming?.upgrade) {
    const res = state.incoming;
    req.res = res;
    socket.removeListener("data", socketOnData);
    socket.removeListener("end", socketOnEnd);
    socket.removeListener("drain", ondrain);
    if (req.timeoutCb) {
      socket.removeListener("timeout", req.timeoutCb);
    }
    socket.removeListener("timeout", responseOnTimeout);
    freeParser(req, socket);
    const bodyHead = Buffer.from(chunk.subarray(ret, chunk.length));
    const eventName = req.method === "CONNECT" ? "connect" : "upgrade";
    if (req.listenerCount(eventName) > 0) {
      req.upgradeOrConnect = true;
      socket.emit("agentRemove");
      socket.removeListener("close", socketCloseListener);
      socket.removeListener("error", socketErrorListener);
      socket._httpMessage = null;
      (socket as unknown as { readableFlowing: boolean | null }).readableFlowing = null;
      req.emit(eventName, res, socket, bodyHead);
      req.destroyed = true;
      req._closed = true;
      req.emit("close");
    } else {
      socket.destroy();
    }
  } else if (state.incoming?.complete && !statusIsInformational(state.incoming.statusCode)) {
    socket.removeListener("data", socketOnData);
    socket.removeListener("end", socketOnEnd);
    socket.removeListener("drain", ondrain);
    freeParser(req, socket);
  }
}

function socketOnEnd(this: HttpSocket): void {
  handleSocketEnd(this);
}

function handleSocketEnd(socket: HttpSocket): void {
  const req = socket._httpMessage as ClientRequest;
  const state = socket.parser as ClientParserState | null;
  if (!req.res && !socket._hadError) {
    socket._hadError = true;
    req.emit("error", connResetException("socket hang up"));
  }
  if (state) {
    state.parser.finish();
    freeParser(req, socket);
  }
  socket.destroy();
}

function socketCloseListener(this: HttpSocket): void {
  handleSocketClose(this);
}

function handleSocketClose(socket: HttpSocket): void {
  const req = socket._httpMessage as ClientRequest;
  const state = socket.parser as ClientParserState | null;
  const res = req.res;
  req.destroyed = true;
  if (res) {
    if (!res.complete) {
      res.destroy(connResetException("aborted"));
    }
    req._closed = true;
    req.emit("close");
    if (!res.aborted && res.readable) {
      res.push(null);
    }
  } else {
    if (!socket._hadError) {
      socket._hadError = true;
      req.emit("error", connResetException("socket hang up"));
    }
    req._closed = true;
    req.emit("close");
  }
  req.outputData.length = 0;
  if (state) {
    state.parser.finish();
    freeParser(req, socket);
  }
}

function socketErrorListener(this: HttpSocket, error: Error): void {
  handleSocketError(this, error);
}

function handleSocketError(socket: HttpSocket, error: Error): void {
  const req = socket._httpMessage as ClientRequest | null;
  if (req) {
    socket._hadError = true;
    req.emit("error", error);
  }
  const state = socket.parser as ClientParserState | null;
  if (state) {
    state.parser.finish();
    freeParser(req, socket);
  }
  socket.removeListener("data", socketOnData);
  socket.removeListener("end", socketOnEnd);
  socket.destroy();
}

function ondrain(this: HttpSocket): void {
  const message = this._httpMessage as ClientRequest | null;
  if (message && !message.finished && message[kNeedDrain]) {
    message[kNeedDrain] = false;
    message.emit("drain");
  }
}

function responseOnTimeout(this: HttpSocket): void {
  const req = this._httpMessage as ClientRequest | null;
  req?.res?.emit("timeout");
}

function responseKeepAlive(req: ClientRequest): void {
  const socket = req.socket as HttpSocket;
  if (req.timeoutCb) {
    socket.setTimeout(0, req.timeoutCb);
    req.timeoutCb = null;
  }
  socket.removeListener("close", socketCloseListener);
  socket.removeListener("error", socketErrorListener);
  socket.removeListener("data", socketOnData);
  socket.removeListener("end", socketOnEnd);
  // After the 'end' listeners have had their turn, as Node marks it free.
  nextTick(() => {
    req._closed = true;
    req.emit("close");
    req.socket?.emit("free");
  });
  req.destroyed = true;
  if (req.res) {
    req.res.socket = null;
  }
}

function responseOnEnd(this: IncomingMessage): void {
  const req = this.req as ClientRequest;
  const socket = req.socket;
  if (socket) {
    if (req.timeoutCb) {
      socket.removeListener("timeout", emitRequestTimeout);
    }
    socket.removeListener("timeout", responseOnTimeout);
  }
  req._ended = true;
  if (!req.shouldKeepAlive) {
    if (socket?.writable) {
      socket.destroySoon();
    }
  } else if (req.writableFinished && !this.aborted) {
    responseKeepAlive(req);
  }
}

function requestOnFinish(this: ClientRequest): void {
  if (this.shouldKeepAlive && this._ended) {
    responseKeepAlive(this);
  }
}

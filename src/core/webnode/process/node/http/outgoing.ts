// `http.OutgoingMessage`, the base of `ServerResponse` and `ClientRequest`: the
// header table and its API, the head serialiser (`_storeHeader`: framing,
// keep-alive, `Date`, chunked encoding) and the write/end path. Ported from
// Node 22's lib/_http_outgoing.js; like Node it is a legacy `Stream`, not a
// `Writable`, and buffers output until a socket is assigned.
import { Buffer } from "../buffer";
import { invalidArgType, invalidArgValue, makeNodeError, validateString } from "../internalErrors";
import stream from "../stream";
import type { HttpSocket } from "./incoming";
import {
  checkInvalidHeaderChar,
  codedError,
  headersSent,
  invalidChar,
  utcDate,
  validateHeaderName,
  validateHeaderValue,
} from "./common";

/** A header value as `setHeader` takes it. */
export type OutgoingHeaderValue = number | string | readonly string[];
/** `getHeaders()`: lower-cased names, null prototype. */
export type OutgoingHttpHeaders = Record<string, OutgoingHeaderValue | undefined>;

type HeaderEntry = [string, OutgoingHeaderValue];
type WriteCallback = (error?: Error | null) => void;

interface OutputEntry {
  data: string | Uint8Array;
  encoding: BufferEncoding | null | undefined;
  callback: WriteCallback | null | undefined;
}

interface HeaderState {
  connection: boolean;
  contLen: boolean;
  te: boolean;
  date: boolean;
  expect: boolean;
  trailer: boolean;
  header: string;
}

/** The header table: lower-cased name → [name as given, value]. */
export const kOutHeaders = Symbol("kOutHeaders");
/** Set when `write` returned false and a `drain` is owed. */
export const kNeedDrain = Symbol("kNeedDrain");
/** Header names that must not be repeated (the `uniqueHeaders` option). */
export const kUniqueHeaders = Symbol("kUniqueHeaders");
const kSocket = Symbol("kSocket");
const kCorked = Symbol("kCorked");
const kChunkedBuffer = Symbol("kChunkedBuffer");
const kChunkedLength = Symbol("kChunkedLength");
const kBytesWritten = Symbol("kBytesWritten");
const kErrored = Symbol("kErrored");
const kHighWaterMark = Symbol("kHighWaterMark");
const kRejectNonStandardBodyWrites = Symbol("kRejectNonStandardBodyWrites");

const RE_CONN_CLOSE = /(?:^|\W)close(?:$|\W)/i;
const RE_TE_CHUNKED = /(?:^|\W)chunked(?:$|\W)/i;
const crlfBuffer = Buffer.from("\r\n");
const nop = () => {};

function isCookieField(name: string): boolean {
  return name.length === 6 && name.toLowerCase() === "cookie";
}

function byteLengthOf(chunk: string | Uint8Array, encoding?: BufferEncoding | null): number {
  return typeof chunk === "string"
    ? Buffer.byteLength(chunk, encoding ?? "utf8")
    : chunk.byteLength;
}

/** `uniqueHeaders` → a set of lower-cased names, or null. */
export function parseUniqueHeadersOption(headers: unknown): Set<string> | null {
  if (!Array.isArray(headers)) {
    return null;
  }
  return new Set(headers.map((name) => String(name).toLowerCase()));
}

const LegacyStream = stream.Stream;

/** What `new OutgoingMessage(options)` takes. */
export interface OutgoingMessageOptions {
  highWaterMark?: number;
  rejectNonStandardBodyWrites?: boolean;
}

/** `http.OutgoingMessage`. */
export class OutgoingMessage extends LegacyStream {
  outputData: OutputEntry[] = [];
  outputSize = 0;
  writable = true;
  destroyed = false;
  _last = false;
  chunkedEncoding = false;
  shouldKeepAlive = true;
  maxRequestsOnConnectionReached = false;
  _defaultKeepAlive = true;
  useChunkedEncodingByDefault = true;
  sendDate = false;
  _removedConnection = false;
  _removedContLen = false;
  _removedTE = false;
  strictContentLength = false;
  _contentLength: number | string | null = null;
  _hasBody = true;
  _trailer = "";
  finished = false;
  _headerSent = false;
  _closed = false;
  _header: string | null = null;
  _keepAliveTimeout = 0;
  _maxRequestsPerSocket: number | undefined = undefined;
  _onPendingData: (delta: number) => void = nop;
  /** Set by `ClientRequest` when an agent manages the connection. */
  declare agent: unknown;
  /** The status code `_storeHeader` checks; `ServerResponse` owns it. */
  declare statusCode: number | undefined;

  [kOutHeaders]: Record<string, HeaderEntry> | null = null;
  [kNeedDrain] = false;
  [kUniqueHeaders]: Set<string> | null = null;
  [kSocket]: HttpSocket | null = null;
  [kCorked] = 0;
  [kChunkedBuffer]: Array<string | Uint8Array | BufferEncoding | WriteCallback | null | undefined> =
    [];
  [kChunkedLength] = 0;
  [kBytesWritten] = 0;
  [kErrored]: Error | null | undefined = null;
  [kHighWaterMark]: number;
  [kRejectNonStandardBodyWrites]: boolean;

  constructor(options?: OutgoingMessageOptions) {
    super();
    this[kHighWaterMark] = options?.highWaterMark ?? stream.getDefaultHighWaterMark(false);
    this[kRejectNonStandardBodyWrites] = options?.rejectNonStandardBodyWrites ?? false;
  }

  get errored(): Error | null | undefined {
    return this[kErrored];
  }

  get closed(): boolean {
    return this._closed;
  }

  get writableFinished(): boolean {
    return (
      this.finished &&
      this.outputSize === 0 &&
      (!this[kSocket] || this[kSocket].writableLength === 0)
    );
  }

  get writableObjectMode(): boolean {
    return false;
  }

  get writableLength(): number {
    return (
      this.outputSize + this[kChunkedLength] + (this[kSocket] ? this[kSocket].writableLength : 0)
    );
  }

  get writableHighWaterMark(): number {
    return this[kSocket] ? this[kSocket].writableHighWaterMark : this[kHighWaterMark];
  }

  get writableCorked(): number {
    return this[kCorked];
  }

  get writableEnded(): boolean {
    return this.finished;
  }

  get writableNeedDrain(): boolean {
    return !this.destroyed && !this.finished && this[kNeedDrain];
  }

  get headersSent(): boolean {
    return !!this._header;
  }

  get connection(): HttpSocket | null {
    return this[kSocket];
  }

  set connection(value: HttpSocket | null) {
    this.socket = value;
  }

  get socket(): HttpSocket | null {
    return this[kSocket];
  }

  set socket(value: HttpSocket | null) {
    for (let n = 0; n < this[kCorked]; n++) {
      value?.cork();
      this[kSocket]?.uncork();
    }
    this[kSocket] = value;
  }

  /** Deprecated (DEP0066): the headers as an object. */
  get _headers(): OutgoingHttpHeaders {
    return this.getHeaders();
  }

  set _headers(value: OutgoingHttpHeaders | null) {
    if (value == null) {
      this[kOutHeaders] = null;
    } else if (typeof value === "object") {
      const headers: Record<string, HeaderEntry> = Object.create(null);
      this[kOutHeaders] = headers;
      for (const name of Object.keys(value)) {
        headers[name.toLowerCase()] = [name, value[name] as OutgoingHeaderValue];
      }
    }
  }

  /** Deprecated (DEP0066): lower-cased name → name as given. */
  get _headerNames(): Record<string, string> | null {
    const headers = this[kOutHeaders];
    if (headers === null) {
      return null;
    }
    const out: Record<string, string> = Object.create(null);
    for (const key of Object.keys(headers)) {
      out[key] = headers[key][0];
    }
    return out;
  }

  /** The headers keyed by their names as given. */
  _renderHeaders(): Record<string, OutgoingHeaderValue> {
    if (this._header) {
      throw headersSent("render");
    }
    const headers: Record<string, OutgoingHeaderValue> = {};
    const map = this[kOutHeaders];
    if (map !== null) {
      for (const key of Object.keys(map)) {
        headers[map[key][0]] = map[key][1];
      }
    }
    return headers;
  }

  cork(): void {
    this[kCorked]++;
    this[kSocket]?.cork();
  }

  uncork(): void {
    this[kCorked]--;
    this[kSocket]?.uncork();
    if (this[kCorked] || this[kChunkedBuffer].length === 0) {
      return;
    }
    const length = this[kChunkedLength];
    const buffered = this[kChunkedBuffer];
    const callbacks: WriteCallback[] = [];
    this._send(length.toString(16), "latin1", null);
    this._send(crlfBuffer, null, null);
    for (let n = 0; n < buffered.length; n += 3) {
      this._send(
        buffered[n] as string | Uint8Array,
        buffered[n + 1] as BufferEncoding | null,
        null,
      );
      const callback = buffered[n + 2];
      if (typeof callback === "function") {
        callbacks.push(callback);
      }
    }
    this._send(
      crlfBuffer,
      null,
      callbacks.length
        ? (error) => {
            for (const callback of callbacks) {
              callback(error);
            }
          }
        : null,
    );
    this[kChunkedBuffer].length = 0;
    this[kChunkedLength] = 0;
  }

  /** The socket's idle timeout, once there is a socket. */
  setTimeout(msecs: number, callback?: () => void): this {
    if (callback) {
      this.on("timeout", callback);
    }
    const socket = this[kSocket];
    if (!socket) {
      this.once("socket", (assigned: HttpSocket) => assigned.setTimeout(msecs));
    } else {
      socket.setTimeout(msecs);
    }
    return this;
  }

  /** Destroys the message and its socket. */
  destroy(error?: Error): this {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;
    this[kErrored] = error;
    const socket = this[kSocket];
    if (socket) {
      socket.destroy(error);
    } else {
      this.once("socket", (assigned: HttpSocket) => assigned.destroy(error));
    }
    return this;
  }

  /** Sends `data`, preceded by the stored head the first time. */
  _send(
    data: string | Uint8Array,
    encoding?: BufferEncoding | null,
    callback?: WriteCallback | null,
    byteLength?: number,
  ): boolean {
    let payload = data;
    if (!this._headerSent && this._header !== null) {
      if (
        typeof payload === "string" &&
        (encoding === "utf8" || encoding === "latin1" || !encoding)
      ) {
        payload = this._header + payload;
      } else {
        const header = this._header;
        this.outputData.unshift({ data: header, encoding: "latin1", callback: null });
        this.outputSize += header.length;
        this._onPendingData(header.length);
      }
      this._headerSent = true;
    }
    return this._writeRaw(payload, encoding, callback, byteLength);
  }

  /** Writes to the socket when this message owns it, else queues the output. */
  _writeRaw(
    data: string | Uint8Array,
    encoding?: BufferEncoding | null | WriteCallback,
    callback?: WriteCallback | null,
    _size?: number,
  ): boolean {
    const connection = this[kSocket];
    if (connection?.destroyed) {
      return false;
    }
    let enc = encoding;
    let cb = callback;
    if (typeof enc === "function") {
      cb = enc;
      enc = null;
    }
    if (connection && connection._httpMessage === this && connection.writable) {
      if (this.outputData.length) {
        this._flushOutput(connection);
      }
      return writeToSocket(connection, data, enc, cb);
    }
    this.outputData.push({ data, encoding: enc, callback: cb });
    this.outputSize += data.length;
    this._onPendingData(data.length);
    return this.outputSize < this[kHighWaterMark];
  }

  /** Serialises the head: the first line, `headers`, and the framing Node adds. */
  _storeHeader(firstLine: string, headers: unknown): void {
    const state: HeaderState = {
      connection: false,
      contLen: false,
      te: false,
      date: false,
      expect: false,
      trailer: false,
      header: firstLine,
    };
    if (headers) {
      if (headers === this[kOutHeaders]) {
        const table = headers as Record<string, HeaderEntry>;
        for (const key in table) {
          const entry = table[key];
          processHeader(this, state, entry[0], entry[1], false);
        }
      } else if (Array.isArray(headers)) {
        if (headers.length && Array.isArray(headers[0])) {
          for (const entry of headers as unknown[][]) {
            processHeader(this, state, entry[0], entry[1], true);
          }
        } else {
          if (headers.length % 2 !== 0) {
            throw invalidArgValue("headers", headers);
          }
          for (let n = 0; n < headers.length; n += 2) {
            processHeader(this, state, headers[n], headers[n + 1], true);
          }
        }
      } else {
        const table = headers as Record<string, unknown>;
        for (const key in table) {
          if (Object.hasOwn(table, key)) {
            processHeader(this, state, key, table[key], true);
          }
        }
      }
    }

    let { header } = state;
    if (this.sendDate && !state.date) {
      header += `Date: ${utcDate()}\r\n`;
    }
    if (this.chunkedEncoding && (this.statusCode === 204 || this.statusCode === 304)) {
      this.chunkedEncoding = false;
      this.shouldKeepAlive = false;
    }
    if (this._removedConnection) {
      this._last = !this.shouldKeepAlive;
    } else if (!state.connection) {
      const shouldSendKeepAlive =
        this.shouldKeepAlive && (state.contLen || this.useChunkedEncodingByDefault || this.agent);
      if (shouldSendKeepAlive && this.maxRequestsOnConnectionReached) {
        header += "Connection: close\r\n";
      } else if (shouldSendKeepAlive) {
        header += "Connection: keep-alive\r\n";
        if (this._keepAliveTimeout && this._defaultKeepAlive) {
          const timeoutSeconds = Math.floor(this._keepAliveTimeout / 1000);
          let max = "";
          if (~~(this._maxRequestsPerSocket ?? 0) > 0) {
            max = `, max=${this._maxRequestsPerSocket}`;
          }
          header += `Keep-Alive: timeout=${timeoutSeconds}${max}\r\n`;
        }
      } else {
        this._last = true;
        header += "Connection: close\r\n";
      }
    }
    if (!state.contLen && !state.te) {
      if (!this._hasBody) {
        this.chunkedEncoding = false;
      } else if (!this.useChunkedEncodingByDefault) {
        this._last = true;
      } else if (
        !state.trailer &&
        !this._removedContLen &&
        typeof this._contentLength === "number"
      ) {
        header += `Content-Length: ${this._contentLength}\r\n`;
      } else if (!this._removedTE) {
        header += "Transfer-Encoding: chunked\r\n";
        this.chunkedEncoding = true;
      } else {
        this._last = true;
      }
    }
    if (this.chunkedEncoding !== true && state.trailer) {
      throw codedError(
        "ERR_HTTP_TRAILER_INVALID",
        "Trailers are invalid with this transfer encoding",
      );
    }
    this._header = `${header}\r\n`;
    this._headerSent = false;
    if (state.expect) {
      this._send("");
    }
  }

  setHeader(name: string, value: OutgoingHeaderValue): this {
    if (this._header) {
      throw headersSent("set");
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);
    let headers = this[kOutHeaders];
    if (headers === null) {
      headers = Object.create(null) as Record<string, HeaderEntry>;
      this[kOutHeaders] = headers;
    }
    headers[name.toLowerCase()] = [name, value];
    return this;
  }

  /** `setHeaders(headers)`: from a `Headers` or a `Map`; `set-cookie` values gather into one. */
  setHeaders(headers: Headers | Map<string, OutgoingHeaderValue>): this {
    if (this._header) {
      throw headersSent("set");
    }
    const candidate = headers as unknown as { keys?: unknown; get?: unknown } | null;
    if (
      !candidate ||
      Array.isArray(candidate) ||
      typeof candidate.keys !== "function" ||
      typeof candidate.get !== "function"
    ) {
      throw invalidArgType("headers", ["Headers", "Map"], headers);
    }
    const cookies: string[] = [];
    for (const [key, value] of headers as Iterable<[string, OutgoingHeaderValue]>) {
      if (key === "set-cookie") {
        if (Array.isArray(value)) {
          cookies.push(...(value as string[]));
        } else {
          cookies.push(String(value));
        }
        continue;
      }
      this.setHeader(key, value);
    }
    if (cookies.length) {
      this.setHeader("set-cookie", cookies);
    }
    return this;
  }

  appendHeader(name: string, value: OutgoingHeaderValue): this {
    if (this._header) {
      throw headersSent("append");
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const field = name.toLowerCase();
    const headers = this[kOutHeaders];
    if (headers === null || !headers[field]) {
      return this.setHeader(name, value);
    }
    const entry = headers[field];
    if (!Array.isArray(entry[1])) {
      entry[1] = [entry[1] as string];
    }
    const existing = entry[1] as string[];
    if (Array.isArray(value)) {
      existing.push(...(value as string[]));
    } else {
      existing.push(value as string);
    }
    return this;
  }

  getHeader(name: string): OutgoingHeaderValue | undefined {
    validateString(name, "name");
    const headers = this[kOutHeaders];
    if (headers === null) {
      return undefined;
    }
    return headers[name.toLowerCase()]?.[1];
  }

  getHeaderNames(): string[] {
    return this[kOutHeaders] !== null ? Object.keys(this[kOutHeaders]) : [];
  }

  getRawHeaderNames(): string[] {
    const headers = this[kOutHeaders];
    return headers === null ? [] : Object.values(headers).map((entry) => entry[0]);
  }

  getHeaders(): OutgoingHttpHeaders {
    const headers = this[kOutHeaders];
    const result: OutgoingHttpHeaders = Object.create(null);
    if (headers) {
      for (const key of Object.keys(headers)) {
        result[key] = headers[key][1];
      }
    }
    return result;
  }

  hasHeader(name: string): boolean {
    validateString(name, "name");
    return this[kOutHeaders] !== null && !!this[kOutHeaders][name.toLowerCase()];
  }

  removeHeader(name: string): void {
    validateString(name, "name");
    if (this._header) {
      throw headersSent("remove");
    }
    const key = name.toLowerCase();
    switch (key) {
      case "connection":
        this._removedConnection = true;
        break;
      case "content-length":
        this._removedContLen = true;
        break;
      case "transfer-encoding":
        this._removedTE = true;
        break;
      case "date":
        this.sendDate = false;
        break;
    }
    if (this[kOutHeaders] !== null) {
      delete this[kOutHeaders][key];
    }
  }

  /** Stores the implicit head; `ServerResponse` and `ClientRequest` define it. */
  _implicitHeader(): void {
    throw codedError(
      "ERR_METHOD_NOT_IMPLEMENTED",
      "The _implicitHeader() method is not implemented",
    );
  }

  write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback | null,
    callback?: WriteCallback,
  ): boolean {
    let enc = encoding;
    let cb = callback;
    if (typeof enc === "function") {
      cb = enc;
      enc = null;
    }
    const ret = writeImpl(this, chunk, enc, cb, false);
    if (!ret) {
      this[kNeedDrain] = true;
    }
    return ret;
  }

  /** Sets the trailers sent after a chunked body. */
  addTrailers(
    headers: Record<string, OutgoingHeaderValue> | ReadonlyArray<[string, string]>,
  ): void {
    this._trailer = "";
    const isArray = Array.isArray(headers);
    const table = headers as Record<string, unknown>;
    for (const key of Object.keys(headers)) {
      let field: string;
      let value: unknown;
      if (isArray) {
        const entry = table[key] as [string, unknown];
        field = entry[0];
        value = entry[1];
      } else {
        field = key;
        value = table[key];
      }
      validateHeaderName(field, "Trailer name");
      const unique = this[kUniqueHeaders];
      if (
        Array.isArray(value) &&
        value.length > 1 &&
        (!unique || !unique.has(field.toLowerCase()))
      ) {
        for (const item of value) {
          if (checkInvalidHeaderChar(item)) {
            throw invalidChar("trailer content", field);
          }
          this._trailer += `${field}: ${String(item)}\r\n`;
        }
      } else {
        const joined = Array.isArray(value) ? value.join("; ") : value;
        if (checkInvalidHeaderChar(joined)) {
          throw invalidChar("trailer content", field);
        }
        this._trailer += `${field}: ${String(joined)}\r\n`;
      }
    }
  }

  end(
    chunk?: string | Uint8Array | WriteCallback | null,
    encoding?: BufferEncoding | WriteCallback | null,
    callback?: WriteCallback,
  ): this {
    let data = chunk;
    let enc = encoding;
    let cb = callback;
    if (typeof data === "function") {
      cb = data;
      data = null;
      enc = null;
    } else if (typeof enc === "function") {
      cb = enc;
      enc = null;
    }
    const socket = this[kSocket];
    if (data) {
      if (this.finished) {
        onError(this, writeAfterEnd(), typeof cb !== "function" ? nop : cb);
        return this;
      }
      socket?.cork();
      writeImpl(this, data, enc, null, true);
    } else if (this.finished) {
      if (typeof cb === "function") {
        if (!this.writableFinished) {
          this.on("finish", cb);
        } else {
          cb(
            codedError(
              "ERR_STREAM_ALREADY_FINISHED",
              "Cannot call end after a stream was finished",
            ),
          );
        }
      }
      return this;
    } else if (!this._header) {
      socket?.cork();
      this._contentLength = 0;
      this._implicitHeader();
    }
    if (typeof cb === "function") {
      this.once("finish", cb);
    }
    if (strictContentLength(this) && this[kBytesWritten] !== Number(this._contentLength)) {
      throw contentLengthMismatch(this[kBytesWritten], this._contentLength);
    }
    const finish = () => onFinish(this);
    if (this._hasBody && this.chunkedEncoding) {
      this._send(`0\r\n${this._trailer}\r\n`, "latin1", finish);
    } else if (!this._headerSent || this.writableLength || data) {
      this._send("", "latin1", finish);
    } else {
      queueMicrotask(finish);
    }
    const current = this[kSocket];
    if (current) {
      // Fully uncork the connection on end().
      (current as unknown as { _writableState: { corked: number } })._writableState.corked = 1;
      current.uncork();
    }
    this[kCorked] = 1;
    this.uncork();
    this.finished = true;
    if (this.outputData.length === 0 && current && current._httpMessage === this) {
      this._finish();
    }
    return this;
  }

  /** Emits `prefinish` once the message is handed to its socket. */
  _finish(): void {
    this.emit("prefinish");
  }

  /** Flushes queued output to a newly assigned socket. */
  _flush(): void {
    const socket = this[kSocket];
    if (socket?.writable) {
      const ret = this._flushOutput(socket);
      if (this.finished) {
        this._finish();
      } else if (ret && this[kNeedDrain]) {
        this[kNeedDrain] = false;
        this.emit("drain");
      }
    }
  }

  _flushOutput(socket: HttpSocket): boolean | undefined {
    const length = this.outputData.length;
    if (length <= 0) {
      return undefined;
    }
    const output = this.outputData;
    socket.cork();
    let ret: boolean | undefined;
    for (let i = 0; i < length; i++) {
      const { data, encoding, callback } = output[i];
      ret = writeToSocket(socket, data, encoding, callback);
    }
    socket.uncork();
    this.outputData = [];
    this._onPendingData(-this.outputSize);
    this.outputSize = 0;
    return ret;
  }

  /** Sends the head now, before any body. */
  flushHeaders(): void {
    if (!this._header) {
      this._implicitHeader();
    }
    this._send("");
  }

  /** An `OutgoingMessage` is not readable. */
  override pipe<T>(_destination: T): T {
    this.emit("error", codedError("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable"));
    return _destination;
  }
}

function writeToSocket(
  socket: HttpSocket,
  data: string | Uint8Array,
  encoding: BufferEncoding | null | undefined,
  callback: WriteCallback | null | undefined,
): boolean {
  const write = socket.write as (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | null,
    cb?: WriteCallback | null,
  ) => boolean;
  return write.call(socket, data, encoding ?? undefined, callback ?? undefined);
}

function processHeader(
  self: OutgoingMessage,
  state: HeaderState,
  key: unknown,
  value: unknown,
  validate: boolean,
): void {
  if (validate) {
    validateHeaderName(key);
  }
  const name = key as string;
  let headerValue = value;
  if (Array.isArray(headerValue)) {
    const unique = self[kUniqueHeaders];
    if (
      (headerValue.length < 2 || !isCookieField(name)) &&
      (!unique || !unique.has(name.toLowerCase()))
    ) {
      for (const item of headerValue) {
        storeHeader(self, state, name, item, validate);
      }
      return;
    }
    headerValue = headerValue.join("; ");
  }
  storeHeader(self, state, name, headerValue, validate);
}

function storeHeader(
  self: OutgoingMessage,
  state: HeaderState,
  key: string,
  value: unknown,
  validate: boolean,
): void {
  if (validate) {
    validateHeaderValue(key, value);
  }
  state.header += `${key}: ${String(value)}\r\n`;
  matchHeader(self, state, key, String(value));
}

function matchHeader(
  self: OutgoingMessage,
  state: HeaderState,
  rawField: string,
  value: string,
): void {
  if (rawField.length < 4 || rawField.length > 17) {
    return;
  }
  const field = rawField.toLowerCase();
  switch (field) {
    case "connection":
      state.connection = true;
      self._removedConnection = false;
      if (RE_CONN_CLOSE.test(value)) {
        self._last = true;
      } else {
        self.shouldKeepAlive = true;
      }
      break;
    case "transfer-encoding":
      state.te = true;
      self._removedTE = false;
      if (RE_TE_CHUNKED.test(value)) {
        self.chunkedEncoding = true;
      }
      break;
    case "content-length":
      state.contLen = true;
      self._contentLength = value;
      self._removedContLen = false;
      break;
    case "date":
    case "expect":
    case "trailer":
      state[field] = true;
      break;
    case "keep-alive":
      self._defaultKeepAlive = false;
      break;
  }
}

function writeAfterEnd(): Error {
  return codedError("ERR_STREAM_WRITE_AFTER_END", "write after end");
}

function contentLengthMismatch(actual: number, expected: unknown): Error {
  return makeNodeError(
    "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    `Response body's content-length of ${actual} byte(s) does not match the content-length of ${String(expected)} byte(s) set in header`,
    Error,
  );
}

function strictContentLength(message: OutgoingMessage): boolean {
  return (
    message.strictContentLength &&
    message._contentLength != null &&
    message._hasBody &&
    !message._removedContLen &&
    !message.chunkedEncoding &&
    !message.hasHeader("transfer-encoding")
  );
}

function onError(message: OutgoingMessage, error: Error, callback: WriteCallback): void {
  if (message.destroyed) {
    return;
  }
  queueMicrotask(() => {
    callback(error);
    if (!message.destroyed) {
      message.emit("error", error);
    }
  });
}

function onFinish(message: OutgoingMessage): void {
  if (message.socket?._hadError) {
    return;
  }
  message.emit("finish");
}

function writeImpl(
  message: OutgoingMessage,
  chunk: unknown,
  encoding: BufferEncoding | null | undefined,
  callback: WriteCallback | null | undefined,
  fromEnd: boolean,
): boolean {
  const cb: WriteCallback = typeof callback === "function" ? callback : nop;
  if (chunk === null) {
    throw codedError("ERR_STREAM_NULL_VALUES", "May not write null values to stream");
  } else if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
    throw invalidArgType("chunk", ["string", "Buffer", "Uint8Array"], chunk);
  }
  let error: Error | undefined;
  if (message.finished) {
    error = writeAfterEnd();
  } else if (message.destroyed) {
    error = codedError("ERR_STREAM_DESTROYED", "Cannot call write after a stream was destroyed");
  }
  if (error) {
    if (!message.destroyed) {
      onError(message, error, cb);
    } else {
      const failure = error;
      queueMicrotask(() => cb(failure));
    }
    return false;
  }
  let length: number | undefined;
  if (message.strictContentLength) {
    length ??= byteLengthOf(chunk, encoding);
    if (
      strictContentLength(message) &&
      (fromEnd
        ? message[kBytesWritten] + length !== Number(message._contentLength)
        : message[kBytesWritten] + length > Number(message._contentLength))
    ) {
      throw contentLengthMismatch(length + message[kBytesWritten], message._contentLength);
    }
    message[kBytesWritten] += length;
  }
  if (!message._header) {
    if (fromEnd) {
      length ??= byteLengthOf(chunk, encoding);
      message._contentLength = length;
    }
    message._implicitHeader();
  }
  if (!message._hasBody) {
    if (message[kRejectNonStandardBodyWrites]) {
      throw codedError(
        "ERR_HTTP_BODY_NOT_ALLOWED",
        "Adding content for this request method or response status is not allowed.",
      );
    }
    queueMicrotask(() => cb());
    return true;
  }
  const socket = message.socket;
  if (!fromEnd && socket && !socket.writableCorked) {
    socket.cork();
    queueMicrotask(() => socket.uncork());
  }
  if (message.chunkedEncoding && chunk.length !== 0) {
    length ??= byteLengthOf(chunk, encoding);
    if (message[kCorked] && message._headerSent) {
      message[kChunkedBuffer].push(chunk, encoding, cb);
      message[kChunkedLength] += length;
      return message[kChunkedLength] < message[kHighWaterMark];
    }
    message._send(length.toString(16), "latin1", null);
    message._send(crlfBuffer, null, null);
    message._send(chunk, encoding, null, length);
    return message._send(crlfBuffer, null, cb);
  }
  return message._send(chunk, encoding, cb, length);
}

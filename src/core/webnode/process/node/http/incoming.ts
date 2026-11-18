// `http.IncomingMessage`: a request on the server side, a response on the
// client side. A Readable fed by the connection's parser (or, for a request
// routed through `fetch`, by the response body). Header joining follows Node's
// `_addHeaderLine`: `set-cookie` is an array, `cookie` joins with `; `, the
// single-value fields keep their first value, the rest join with `, `.
import { finished, Readable } from "../stream";
import type { Socket } from "../net/socket";
import { nextTick } from "../eventLoop";

/** `message.headers`: lower-cased names. */
export type IncomingHttpHeaders = Record<string, string | string[] | undefined>;

const kHeaders = Symbol("kHeaders");
const kHeadersDistinct = Symbol("kHeadersDistinct");
const kHeadersCount = Symbol("kHeadersCount");
const kTrailers = Symbol("kTrailers");
const kTrailersDistinct = Symbol("kTrailersDistinct");
const kTrailersCount = Symbol("kTrailersCount");

/** A socket as `http` uses it: `_paused` is set while the server holds reads back. */
export type HttpSocket = Socket & { _paused?: boolean };

interface ReadableStateView {
  readingMore: boolean;
  resumeScheduled: boolean;
}

/** The Readable's internal state, which Node's http reads directly. */
export function readableStateOf(stream: Readable): ReadableStateView {
  return (stream as unknown as { _readableState: ReadableStateView })._readableState;
}

/** Resumes reading the socket unless the server is holding it back. */
export function readStart(socket: HttpSocket | null): void {
  if (socket && !socket._paused && socket.readable) {
    socket.resume();
  }
}

/** Pauses reading the socket. */
export function readStop(socket: HttpSocket | null): void {
  socket?.pause();
}

function matchKnownFields(field: string, lowercased = false): string {
  switch (field.length) {
    case 3:
      if (field === "Age" || field === "age") return "age";
      break;
    case 4:
      if (field === "Host" || field === "host") return "host";
      if (field === "From" || field === "from") return "from";
      if (field === "ETag" || field === "etag") return "etag";
      if (field === "Date" || field === "date") return "\u0000date";
      if (field === "Vary" || field === "vary") return "\u0000vary";
      break;
    case 6:
      if (field === "Server" || field === "server") return "server";
      if (field === "Cookie" || field === "cookie") return "\u0002cookie";
      if (field === "Origin" || field === "origin") return "\u0000origin";
      if (field === "Expect" || field === "expect") return "\u0000expect";
      if (field === "Accept" || field === "accept") return "\u0000accept";
      break;
    case 7:
      if (field === "Referer" || field === "referer") return "referer";
      if (field === "Expires" || field === "expires") return "expires";
      if (field === "Upgrade" || field === "upgrade") return "\u0000upgrade";
      break;
    case 8:
      if (field === "Location" || field === "location") return "location";
      if (field === "If-Match" || field === "if-match") return "\u0000if-match";
      break;
    case 10:
      if (field === "User-Agent" || field === "user-agent") return "user-agent";
      if (field === "Set-Cookie" || field === "set-cookie") return "\u0001";
      if (field === "Connection" || field === "connection") return "\u0000connection";
      break;
    case 11:
      if (field === "Retry-After" || field === "retry-after") return "retry-after";
      break;
    case 12:
      if (field === "Content-Type" || field === "content-type") return "content-type";
      if (field === "Max-Forwards" || field === "max-forwards") return "max-forwards";
      break;
    case 13:
      if (field === "Authorization" || field === "authorization") return "authorization";
      if (field === "Last-Modified" || field === "last-modified") return "last-modified";
      if (field === "Cache-Control" || field === "cache-control") return "\u0000cache-control";
      if (field === "If-None-Match" || field === "if-none-match") return "\u0000if-none-match";
      break;
    case 14:
      if (field === "Content-Length" || field === "content-length") return "content-length";
      break;
    case 15:
      if (field === "Accept-Encoding" || field === "accept-encoding")
        return "\u0000accept-encoding";
      if (field === "Accept-Language" || field === "accept-language")
        return "\u0000accept-language";
      if (field === "X-Forwarded-For" || field === "x-forwarded-for")
        return "\u0000x-forwarded-for";
      break;
    case 16:
      if (field === "Content-Encoding" || field === "content-encoding")
        return "\u0000content-encoding";
      if (field === "X-Forwarded-Host" || field === "x-forwarded-host")
        return "\u0000x-forwarded-host";
      break;
    case 17:
      if (field === "If-Modified-Since" || field === "if-modified-since")
        return "if-modified-since";
      if (field === "Transfer-Encoding" || field === "transfer-encoding")
        return "\u0000transfer-encoding";
      if (field === "X-Forwarded-Proto" || field === "x-forwarded-proto")
        return "\u0000x-forwarded-proto";
      break;
    case 19:
      if (field === "Proxy-Authorization" || field === "proxy-authorization")
        return "proxy-authorization";
      if (field === "If-Unmodified-Since" || field === "if-unmodified-since")
        return "if-unmodified-since";
      break;
  }
  if (lowercased) {
    return `\u0000${field}`;
  }
  return matchKnownFields(field.toLowerCase(), true);
}

/** `http.IncomingMessage`. */
export class IncomingMessage extends Readable {
  socket: HttpSocket | null;
  httpVersionMajor: number | null = null;
  httpVersionMinor: number | null = null;
  httpVersion: string | null = null;
  complete = false;
  rawHeaders: string[] = [];
  rawTrailers: string[] = [];
  joinDuplicateHeaders = false;
  aborted = false;
  upgrade: boolean | null = null;
  url = "";
  method: string | null = null;
  statusCode: number | null = null;
  statusMessage: string | null = null;
  client: HttpSocket | null;
  _consuming = false;
  _dumped = false;
  /** The request this response answers (client side). */
  req: unknown = undefined;

  [kHeaders]: IncomingHttpHeaders | null = null;
  [kHeadersDistinct]: Record<string, string[]> | null = null;
  [kHeadersCount] = 0;
  [kTrailers]: IncomingHttpHeaders | null = null;
  [kTrailersDistinct]: Record<string, string[]> | null = null;
  [kTrailersCount] = 0;

  constructor(socket?: HttpSocket | null) {
    super(socket ? { highWaterMark: socket.readableHighWaterMark } : undefined);
    readableStateOf(this).readingMore = true;
    this.socket = socket ?? null;
    this.client = socket ?? null;
  }

  get connection(): HttpSocket | null {
    return this.socket;
  }

  set connection(value: HttpSocket | null) {
    this.socket = value;
  }

  get headers(): IncomingHttpHeaders {
    if (!this[kHeaders]) {
      const dest: IncomingHttpHeaders = {};
      this[kHeaders] = dest;
      for (let n = 0; n < this[kHeadersCount]; n += 2) {
        this._addHeaderLine(this.rawHeaders[n], this.rawHeaders[n + 1], dest);
      }
    }
    return this[kHeaders];
  }

  set headers(value: IncomingHttpHeaders) {
    this[kHeaders] = value;
  }

  get headersDistinct(): Record<string, string[]> {
    if (!this[kHeadersDistinct]) {
      const dest: Record<string, string[]> = {};
      this[kHeadersDistinct] = dest;
      for (let n = 0; n < this[kHeadersCount]; n += 2) {
        this._addHeaderLineDistinct(this.rawHeaders[n], this.rawHeaders[n + 1], dest);
      }
    }
    return this[kHeadersDistinct];
  }

  set headersDistinct(value: Record<string, string[]>) {
    this[kHeadersDistinct] = value;
  }

  get trailers(): IncomingHttpHeaders {
    if (!this[kTrailers]) {
      const dest: IncomingHttpHeaders = {};
      this[kTrailers] = dest;
      for (let n = 0; n < this[kTrailersCount]; n += 2) {
        this._addHeaderLine(this.rawTrailers[n], this.rawTrailers[n + 1], dest);
      }
    }
    return this[kTrailers];
  }

  set trailers(value: IncomingHttpHeaders) {
    this[kTrailers] = value;
  }

  get trailersDistinct(): Record<string, string[]> {
    if (!this[kTrailersDistinct]) {
      const dest: Record<string, string[]> = {};
      this[kTrailersDistinct] = dest;
      for (let n = 0; n < this[kTrailersCount]; n += 2) {
        this._addHeaderLineDistinct(this.rawTrailers[n], this.rawTrailers[n + 1], dest);
      }
    }
    return this[kTrailersDistinct];
  }

  set trailersDistinct(value: Record<string, string[]>) {
    this[kTrailersDistinct] = value;
  }

  /** `message.setTimeout(msecs[, callback])`: the socket's idle timeout. */
  setTimeout(msecs: number, callback?: () => void): this {
    if (callback) {
      this.on("timeout", callback);
    }
    this.socket?.setTimeout(msecs);
    return this;
  }

  override _read(): void {
    if (!this._consuming) {
      readableStateOf(this).readingMore = false;
      this._consuming = true;
    }
    if (this.socket?.readable) {
      readStart(this.socket);
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.readableEnded || !this.complete) {
      this.aborted = true;
      this.emit("aborted");
    }
    const report = (failure: Error | null) => {
      nextTick(() => {
        if (this.listenerCount("error") === 0) {
          callback();
        } else {
          callback(failure);
        }
      });
    };
    const socket = this.socket;
    if (socket && !socket.destroyed && this.aborted) {
      socket.destroy(error ?? undefined);
      const cleanup = finished(socket, (failure) => {
        let reported: Error | null | undefined = failure;
        if (
          (failure as { code?: string } | null | undefined)?.code === "ERR_STREAM_PREMATURE_CLOSE"
        ) {
          reported = null;
        }
        cleanup();
        report(reported || error);
      });
    } else {
      report(error);
    }
  }

  /** Stores parsed header (or, once complete, trailer) lines. */
  _addHeaderLines(headers: string[], n: number): void {
    if (headers.length === 0) {
      return;
    }
    let dest: IncomingHttpHeaders | null;
    if (this.complete) {
      this.rawTrailers = headers;
      this[kTrailersCount] = n;
      dest = this[kTrailers];
    } else {
      this.rawHeaders = headers;
      this[kHeadersCount] = n;
      dest = this[kHeaders];
    }
    if (dest) {
      for (let i = 0; i < n; i += 2) {
        this._addHeaderLine(headers[i], headers[i + 1], dest);
      }
    }
  }

  /** Adds one header line to `dest` by Node's joining rules. */
  _addHeaderLine(rawField: string, value: string, dest: IncomingHttpHeaders): void {
    let field = matchKnownFields(rawField);
    const flag = field.charCodeAt(0);
    if (flag === 0 || flag === 2) {
      field = field.slice(1);
      const existing = dest[field];
      if (typeof existing === "string") {
        dest[field] = existing + (flag === 0 ? ", " : "; ") + value;
      } else {
        dest[field] = value;
      }
    } else if (flag === 1) {
      const cookies = dest["set-cookie"];
      if (Array.isArray(cookies)) {
        cookies.push(value);
      } else {
        dest["set-cookie"] = [value];
      }
    } else if (this.joinDuplicateHeaders) {
      const existing = dest[field];
      dest[field] = existing === undefined ? value : `${String(existing)}, ${value}`;
    } else if (dest[field] === undefined) {
      dest[field] = value;
    }
  }

  /** Adds one header line to a `headersDistinct` table. */
  _addHeaderLineDistinct(rawField: string, value: string, dest: Record<string, string[]>): void {
    const field = rawField.toLowerCase();
    const existing = dest[field];
    if (existing) {
      existing.push(value);
    } else {
      dest[field] = [value];
    }
  }

  /** Discards the body so the connection can move on. */
  _dump(): void {
    if (!this._dumped) {
      this._dumped = true;
      this.removeAllListeners("data");
      this.resume();
    }
  }
}

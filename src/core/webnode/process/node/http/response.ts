// `http.ServerResponse`: the status line and the 1xx interim responses on top
// of `OutgoingMessage`, and the socket hand-over the server uses to answer
// pipelined requests in order (`assignSocket` / `detachSocket`).
import { invalidArgValue, validateObject } from "../internalErrors";
import type { HttpSocket, IncomingMessage } from "./incoming";
import {
  checkInvalidHeaderChar,
  chunkExpression,
  codedError,
  headersSent,
  invalidChar,
  invalidStatusCode,
  STATUS_CODES,
} from "./common";
import {
  kOutHeaders,
  OutgoingMessage,
  type OutgoingHeaderValue,
  type OutgoingMessageOptions,
} from "./outgoing";

const linkValueRegExp = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s]+(?:=(")?[^;"\s]*\1)?)*$/;
const linkFormat = 'must be an array or string of format "</styles.css>; rel=preload; as=style"';

function validateLinkHeaderFormat(value: unknown, name: string): void {
  if (typeof value === "undefined" || !linkValueRegExp.test(String(value))) {
    throw invalidArgValue(name, value, linkFormat);
  }
}

function validateLinkHeaderValue(hints: unknown): string {
  if (typeof hints === "string") {
    validateLinkHeaderFormat(hints, "hints");
    return hints;
  }
  if (Array.isArray(hints)) {
    for (const link of hints) {
      validateLinkHeaderFormat(link, "hints");
    }
    return hints.join(", ");
  }
  throw invalidArgValue("hints", hints, linkFormat);
}

/** Emits `close` once on a response whose exchange is over. */
export function emitResponseClose(response: OutgoingMessage): void {
  if (!response._closed) {
    response.destroyed = true;
    response._closed = true;
    response.emit("close");
  }
}

function onServerResponseClose(this: HttpSocket): void {
  const message = this._httpMessage;
  if (message instanceof OutgoingMessage) {
    emitResponseClose(message);
  }
}

/** `http.ServerResponse`. */
export class ServerResponse extends OutgoingMessage {
  statusCode = 200;
  statusMessage: string | undefined = undefined;
  req: IncomingMessage;
  _sent100 = false;
  _expect_continue = false;

  constructor(req: IncomingMessage, options?: OutgoingMessageOptions) {
    super(options);
    if (req.method === "HEAD") {
      this._hasBody = false;
    }
    this.req = req;
    this.sendDate = true;
    if ((req.httpVersionMajor ?? 1) < 1 || (req.httpVersionMinor ?? 1) < 1) {
      this.useChunkedEncodingByDefault = chunkExpression.test(String(req.headers.te ?? ""));
      this.shouldKeepAlive = false;
    }
  }

  /** Gives this response the connection; queued output goes out now. */
  assignSocket(socket: HttpSocket): void {
    if (socket._httpMessage) {
      throw codedError("ERR_HTTP_SOCKET_ASSIGNED", "ServerResponse has an already assigned socket");
    }
    socket._httpMessage = this;
    socket.on("close", onServerResponseClose);
    this.socket = socket;
    this.emit("socket", socket);
    this._flush();
  }

  /** Releases the connection for the next response. */
  detachSocket(socket: HttpSocket): void {
    socket.removeListener("close", onServerResponseClose);
    socket._httpMessage = null;
    this.socket = null;
  }

  /** Sends `100 Continue`. */
  writeContinue(callback?: (error?: Error | null) => void): void {
    this._writeRaw("HTTP/1.1 100 Continue\r\n\r\n", "ascii", callback);
    this._sent100 = true;
  }

  /** Sends `102 Processing`. */
  writeProcessing(callback?: (error?: Error | null) => void): void {
    this._writeRaw("HTTP/1.1 102 Processing\r\n\r\n", "ascii", callback);
  }

  /** Sends `103 Early Hints` with a `Link` header and any other hints. */
  writeEarlyHints(hints: Record<string, unknown>, callback?: (error?: Error | null) => void): void {
    let head = "HTTP/1.1 103 Early Hints\r\n";
    validateObject(hints, "hints");
    if (hints.link === null || hints.link === undefined) {
      return;
    }
    const link = validateLinkHeaderValue(hints.link);
    if (link.length === 0) {
      return;
    }
    head += `Link: ${link}\r\n`;
    for (const key of Object.keys(hints)) {
      if (key !== "link") {
        head += `${key}: ${String(hints[key])}\r\n`;
      }
    }
    head += "\r\n";
    this._writeRaw(head, "ascii", callback);
  }

  override _implicitHeader(): void {
    this.writeHead(this.statusCode);
  }

  /**
   * `writeHead(statusCode[, statusMessage][, headers])`. `headers` is an object
   * or a flat `[name, value, ...]` array; with headers already set by
   * `setHeader`, these override them.
   */
  writeHead(
    statusCode: number,
    reason?: string | Record<string, OutgoingHeaderValue> | unknown[],
    obj?: Record<string, OutgoingHeaderValue> | unknown[],
  ): this {
    if (this._header) {
      throw headersSent("write");
    }
    const originalStatusCode = statusCode;
    const code = statusCode | 0;
    if (code < 100 || code > 999) {
      throw invalidStatusCode(originalStatusCode);
    }
    let headersArgument = obj;
    if (typeof reason === "string") {
      this.statusMessage = reason;
    } else {
      this.statusMessage ||= STATUS_CODES[code] || "unknown";
      headersArgument ??= reason;
    }
    this.statusCode = code;
    let headers: unknown;
    if (this[kOutHeaders]) {
      if (Array.isArray(headersArgument)) {
        if (headersArgument.length % 2 !== 0) {
          throw invalidArgValue("headers", headersArgument);
        }
        for (let n = 0; n < headersArgument.length; n += 2) {
          this.removeHeader(String(headersArgument[n]));
        }
        for (let n = 0; n < headersArgument.length; n += 2) {
          const key = headersArgument[n];
          if (key) {
            this.appendHeader(key as string, headersArgument[n + 1] as OutgoingHeaderValue);
          }
        }
      } else if (headersArgument) {
        for (const key of Object.keys(headersArgument)) {
          if (key) {
            this.setHeader(key, headersArgument[key]);
          }
        }
      }
      headers = this[kOutHeaders];
    } else {
      headers = headersArgument;
    }
    if (checkInvalidHeaderChar(this.statusMessage)) {
      throw invalidChar("statusMessage");
    }
    const statusLine = `HTTP/1.1 ${code} ${this.statusMessage}\r\n`;
    if (code === 204 || code === 304 || (code >= 100 && code <= 199)) {
      this._hasBody = false;
    }
    if (this._expect_continue && !this._sent100) {
      this.shouldKeepAlive = false;
    }
    this._storeHeader(statusLine, headers);
    return this;
  }

  /** Alias of `writeHead`. */
  writeHeader(
    statusCode: number,
    reason?: string | Record<string, OutgoingHeaderValue> | unknown[],
    obj?: Record<string, OutgoingHeaderValue> | unknown[],
  ): this {
    return this.writeHead(statusCode, reason, obj);
  }
}

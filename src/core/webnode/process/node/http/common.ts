// What the `http` domain's server, client and messages share: the method and
// status tables, header-token rules and validators, Node's `ERR_HTTP_*`
// errors, the `Date` header cache, and `HttpParser`, the typed wrapper over
// `http-parser-js` (a pure-JS port of Node's own HTTPParser).
import { HTTPParser } from "http-parser-js";
import type { Buffer } from "../buffer";
import { inspectValue, makeNodeError, type NodeError } from "../internalErrors";
import { startTimer } from "../net/errors";

/** `http.METHODS`, as Node 22 lists them. */
export const METHODS: readonly string[] = [
  "ACL",
  "BIND",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LINK",
  "LOCK",
  "M-SEARCH",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MOVE",
  "NOTIFY",
  "OPTIONS",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PURGE",
  "PUT",
  "QUERY",
  "REBIND",
  "REPORT",
  "SEARCH",
  "SOURCE",
  "SUBSCRIBE",
  "TRACE",
  "UNBIND",
  "UNLINK",
  "UNLOCK",
  "UNSUBSCRIBE",
];

/** `http.STATUS_CODES`. */
export const STATUS_CODES: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required",
};

/** `http.maxHeaderSize`: Node's default limit on the size of a message head. */
export const MAX_HEADER_SIZE = 16384;
/** The default limit on header pairs a parser keeps. */
export const MAX_HEADER_PAIRS = 2000;

const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/;

/** `Transfer-Encoding` names chunked. */
export const chunkExpression = /(?:^|\W)chunked(?:$|\W)/i;
/** `Expect` asks for `100-continue`. */
export const continueExpression = /(?:^|\W)100-continue(?:$|\W)/i;

/** Whether `value` is an RFC 7230 token. */
export function checkIsHttpToken(value: string): boolean {
  return tokenRegExp.test(value);
}

/** Whether `value` holds a character a header value may not. */
export function checkInvalidHeaderChar(value: unknown): boolean {
  return headerCharRegex.test(String(value));
}

/** `ERR_INVALID_HTTP_TOKEN`. */
export function invalidHttpToken(label: string, name: unknown): NodeError<TypeError> {
  return makeNodeError<TypeError>(
    "ERR_INVALID_HTTP_TOKEN",
    `${label} must be a valid HTTP token ["${String(name)}"]`,
    TypeError,
  );
}

/** `ERR_INVALID_CHAR`. */
export function invalidChar(name: string, field?: string): NodeError<TypeError> {
  let message = `Invalid character in ${name}`;
  if (field !== undefined) {
    message += ` ["${field}"]`;
  }
  return makeNodeError<TypeError>("ERR_INVALID_CHAR", message, TypeError);
}

/** `ERR_HTTP_HEADERS_SENT`. */
export function headersSent(action: string): NodeError {
  return makeNodeError(
    "ERR_HTTP_HEADERS_SENT",
    `Cannot ${action} headers after they are sent to the client`,
    Error,
  );
}

/** `http.validateHeaderName(name[, label])`. */
export function validateHeaderName(name: unknown, label?: string): asserts name is string {
  if (typeof name !== "string" || !name || !checkIsHttpToken(name)) {
    throw invalidHttpToken(label || "Header name", name);
  }
}

/** `http.validateHeaderValue(name, value)`. */
export function validateHeaderValue(name: string, value: unknown): void {
  if (value === undefined) {
    throw makeNodeError<TypeError>(
      "ERR_HTTP_INVALID_HEADER_VALUE",
      `Invalid value "${String(value)}" for header "${name}"`,
      TypeError,
    );
  }
  if (checkInvalidHeaderChar(value)) {
    throw invalidChar("header content", name);
  }
}

/** `ERR_HTTP_INVALID_STATUS_CODE`. */
export function invalidStatusCode(code: unknown): NodeError<RangeError> {
  return makeNodeError<RangeError>(
    "ERR_HTTP_INVALID_STATUS_CODE",
    `Invalid status code: ${inspectValue(code)}`,
    RangeError,
  );
}

/** A plain coded error, for the many one-line `ERR_*` Node raises here. */
export function codedError(code: string, message: string): NodeError {
  return makeNodeError(code, message, Error);
}

let dateCache: string | null = null;

/** The current `Date` header value, cached for the rest of the second as Node does. */
export function utcDate(): string {
  if (dateCache === null) {
    dateCache = new Date().toUTCString();
    startTimer(() => {
      dateCache = null;
    }, 1000 - new Date().getMilliseconds());
  }
  return dateCache;
}

/** What `onHeadersComplete` hands over: one parsed message head. */
export interface ParsedHead {
  versionMajor: number;
  versionMinor: number;
  /** Raw `[name, value, ...]` pairs, in arrival order. */
  headers: string[];
  /** Request method, for a request parser. */
  method: string | null;
  url: string;
  statusCode: number;
  statusMessage: string;
  upgrade: boolean;
  shouldKeepAlive: boolean;
}

/** Callbacks of an `HttpParser`; `onHeadersComplete` returns 0, 1 (skip body) or 2 (upgrade). */
export interface HttpParserHandlers {
  onHeadersComplete(head: ParsedHead): number | boolean | void;
  onBody(chunk: Buffer): void;
  onMessageComplete(): void;
  onTrailers(trailers: string[]): void;
}

interface RawParser {
  initialize(type: "REQUEST" | "RESPONSE"): void;
  reinitialize(type: "REQUEST" | "RESPONSE"): void;
  execute(chunk: Buffer): number | Error;
  finish(): Error | undefined | void;
  maxHeaderSize: number;
  /** Read position inside the chunk being executed. */
  offset: number;
  [key: number]: unknown;
  [state: string]: unknown;
}

interface RawParserInfo {
  versionMajor: number;
  versionMinor: number;
  headers: string[];
  method: number | string;
  url: string;
  statusCode: number;
  statusMessage: string;
  upgrade: boolean;
  shouldKeepAlive: boolean;
}

const RawHTTPParser = HTTPParser as unknown as {
  new (type?: "REQUEST" | "RESPONSE"): RawParser;
  prototype: Record<string, (this: RawParser) => unknown>;
  methods: string[];
  encoding: string;
  kOnHeaders: number;
  kOnHeadersComplete: number;
  kOnBody: number;
  kOnMessageComplete: number;
};

let parserConfigured = false;

function configureParser(): void {
  if (parserConfigured) {
    return;
  }
  parserConfigured = true;
  // Header bytes are latin1 in Node (llhttp), not 7-bit ASCII.
  RawHTTPParser.encoding = "latin1";
  // llhttp knows QUERY; the JS port's table does not yet.
  if (!RawHTTPParser.methods.includes("QUERY")) {
    RawHTTPParser.methods.push("QUERY");
  }
}

const PARSE_ERROR_REASONS: Record<string, string> = {
  HPE_INVALID_CONSTANT: "Expected HTTP/, RTSP/ or ICE/",
  HPE_INVALID_METHOD: "Invalid method encountered",
  HPE_HEADER_OVERFLOW: "Header overflow",
  HPE_LF_EXPECTED: "Missing expected LF after header value",
  HPE_UNEXPECTED_CONTENT_LENGTH: "Duplicate Content-Length",
  HPE_INVALID_CHUNK_SIZE: "Invalid character in chunk size",
  HPE_INVALID_EOF_STATE: "Invalid EOF state",
  HPE_INVALID_TRANSFER_ENCODING: "Transfer-Encoding can't be present with Content-Length",
};

/** What is wrong with a request line, and at which of its characters. */
interface LineFault {
  code: string;
  reason: string;
  at: number;
}

/** A parse error that already knows its reason and where in the chunk it lies. */
interface LocatedParseError extends Error {
  code: string;
  reason: string;
  bytesParsed: number;
}

function isLocated(error: Error): error is LocatedParseError {
  return typeof (error as { bytesParsed?: unknown }).bytesParsed === "number";
}

/** The versions llhttp takes in a request line. */
const REQUEST_VERSIONS = new Set(["0.9", "1.0", "1.1", "2.0"]);

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

/**
 * What llhttp says of a request line the parser here refused, and at which
 * character: llhttp reads a line byte by byte and stops at the first it cannot
 * take. Null for a line llhttp would take (HTTP/0.9's `GET /`, two spaces
 * before the target), which stays refused as not HTTP.
 */
function requestLineFault(line: string): LineFault | null {
  const methods = RawHTTPParser.methods;
  let at = 0;
  while (at < line.length && methods.some((name) => name.startsWith(line.slice(0, at + 1)))) {
    at += 1;
  }
  if (!methods.includes(line.slice(0, at))) {
    return { code: "HPE_INVALID_METHOD", reason: "Invalid method encountered", at };
  }
  if (line[at] !== " ") {
    return { code: "HPE_INVALID_METHOD", reason: "Expected space after method", at };
  }
  while (line[at] === " ") {
    at += 1;
  }
  at = line.indexOf(" ", at);
  if (at === -1) {
    return null;
  }
  while (line[at] === " ") {
    at += 1;
  }
  const protocol = "HTTP/";
  for (let i = 0; i < protocol.length; i += 1) {
    if (line[at + i] !== protocol[i]) {
      return {
        code: "HPE_INVALID_CONSTANT",
        reason: PARSE_ERROR_REASONS.HPE_INVALID_CONSTANT,
        at: at + i,
      };
    }
  }
  at += protocol.length;
  const version = (reason: string, where: number): LineFault => ({
    code: "HPE_INVALID_VERSION",
    reason,
    at: where,
  });
  if (!isDigit(line[at])) {
    return version("Invalid major version", at);
  }
  if (line[at + 1] !== ".") {
    return version("Expected dot", at + 1);
  }
  if (!isDigit(line[at + 2])) {
    return version("Invalid minor version", at + 2);
  }
  if (!REQUEST_VERSIONS.has(line.slice(at, at + 3))) {
    return version("Invalid HTTP version", at + 3);
  }
  return at + 3 < line.length ? version("Expected CRLF after version", at + 3) : null;
}

/** The line the parser's next step will read whole from its chunk, or undefined if its end is yet to come. */
function wholeLine(raw: RawParser): string | undefined {
  const chunk = raw.chunk as Buffer;
  const newline = chunk.indexOf(0x0a, raw.offset);
  if (newline === -1 || newline >= (raw.end as number)) {
    return undefined;
  }
  const line = String(raw.line) + chunk.toString("latin1", raw.offset, newline);
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Where in its chunk character `at` of a line lies: the line began at `began`
 * in its first chunk, each chunk before the current one brought `pieces` of
 * it, and the current chunk has the rest from `start`.
 */
function placeInChunk(at: number, began: number, pieces: readonly number[], start: number): number {
  let left = at;
  for (const [index, piece] of pieces.entries()) {
    if (left < piece) {
      return (index === 0 ? began : 0) + left;
    }
    left -= piece;
  }
  return start + left;
}

function parseError(error: Error, bytesParsed: number): Error {
  let code = (error as { code?: string }).code;
  if (code === undefined) {
    if (error.message === "invalid request method") {
      code = "HPE_INVALID_METHOD";
    } else if (error.message === "max header size exceeded") {
      code = "HPE_HEADER_OVERFLOW";
    } else if (error.message === "invalid state for EOF") {
      code = "HPE_INVALID_EOF_STATE";
    } else {
      code = "HPE_INVALID_CHUNK_SIZE";
    }
  }
  const reason = isLocated(error) ? error.reason : (PARSE_ERROR_REASONS[code] ?? error.message);
  const result = new Error(`Parse Error: ${reason}`) as Error & Record<string, unknown>;
  result.code = code;
  result.reason = reason;
  result.bytesParsed = isLocated(error) ? error.bytesParsed : bytesParsed;
  return result;
}

function hasLengthAndTransferEncoding(headers: readonly string[]): boolean {
  let length = false;
  let transfer = false;
  for (let i = 0; i < headers.length; i += 2) {
    const name = headers[i]!.toLowerCase();
    length ||= name === "content-length";
    transfer ||= name === "transfer-encoding";
  }
  return length && transfer;
}

/**
 * One HTTP/1.x message parser for a connection: requests on a server socket,
 * responses on a client socket. `execute` returns the bytes consumed or a
 * parse error carrying Node's `HPE_*` code.
 */
export class HttpParser {
  readonly #raw: RawParser;
  #consumed = 0;

  /**
   * `insecure` is Node's `insecureHTTPParser`: it accepts a head that carries
   * both Content-Length and Transfer-Encoding.
   */
  constructor(
    kind: "REQUEST" | "RESPONSE",
    handlers: HttpParserHandlers,
    maxHeaderSize: number,
    insecure = false,
  ) {
    configureParser();
    const raw = new RawHTTPParser(kind);
    // http-parser-js adds every byte of an execute() call that ends in a head
    // state to its own header count, body bytes included, and resets the
    // limit to its 80 KB default after each message. So its count is turned
    // off and the head is measured here: only the bytes its line and header
    // states consume, from a message's first byte to its blank line.
    raw.maxHeaderSize = Infinity;
    raw.reinitialize = (type) => raw.initialize(type);
    let headBytes = 0;
    let headDone = false;
    // A head the parser must refuse once it is whole; raised from the state
    // step, outside the user callback, so execute() returns it as an error.
    let rejected: Error | null = null;
    // Of the request line being read: where it began in the chunk that brought
    // its first byte, and how many of its bytes each chunk before this one
    // brought. A fault is reported at its place in the chunk that holds it,
    // as llhttp reports it.
    let lineBegan = 0;
    let linePieces: number[] = [];
    for (const state of [`${kind}_LINE`, "HEADER"]) {
      const step = RawHTTPParser.prototype[state];
      raw[state] = function (this: RawParser) {
        const start = this.offset;
        headDone = false;
        const line = state === "REQUEST_LINE" ? wholeLine(this) : undefined;
        let result: unknown;
        let fault: LineFault | null = null;
        try {
          result = step.call(this);
          // The parser takes any version number; llhttp only the ones it knows.
          if (line !== undefined && line !== "" && !REQUEST_VERSIONS.has(line.slice(-3))) {
            fault = requestLineFault(line);
          }
        } catch (error) {
          fault = line === undefined ? null : requestLineFault(line);
          if (fault === null) {
            throw error;
          }
        }
        if (fault !== null) {
          throw Object.assign(new Error("Parse Error"), {
            code: fault.code,
            reason: fault.reason,
            bytesParsed: placeInChunk(fault.at, lineBegan, linePieces, start),
          } satisfies Omit<LocatedParseError, keyof Error>);
        }
        if (state === "REQUEST_LINE") {
          if (line !== undefined) {
            linePieces = [];
          } else {
            if (linePieces.length === 0) {
              lineBegan = start;
            }
            linePieces.push(this.offset - start);
          }
        }
        if (rejected !== null) {
          throw rejected;
        }
        if (headDone) {
          headBytes = 0;
        } else {
          headBytes += this.offset - start;
          if (headBytes > maxHeaderSize) {
            throw Object.assign(new Error("Parse Error"), { code: "HPE_HEADER_OVERFLOW" });
          }
        }
        return result;
      };
    }
    raw[RawHTTPParser.kOnHeadersComplete] = (...args: unknown[]) => {
      headDone = true;
      const info: RawParserInfo =
        typeof args[0] === "object" && args[0] !== null
          ? (args[0] as RawParserInfo)
          : {
              versionMajor: args[0] as number,
              versionMinor: args[1] as number,
              headers: args[2] as string[],
              method: args[3] as number,
              url: args[4] as string,
              statusCode: args[5] as number,
              statusMessage: args[6] as string,
              upgrade: args[7] as boolean,
              shouldKeepAlive: args[8] as boolean,
            };
      if (!insecure && hasLengthAndTransferEncoding(info.headers)) {
        // llhttp refuses this framing (request smuggling); skip the message
        // and let the step above report it.
        rejected = Object.assign(new Error("Parse Error"), {
          code: "HPE_INVALID_TRANSFER_ENCODING",
        });
        return 1;
      }
      const method =
        kind === "REQUEST"
          ? typeof info.method === "string"
            ? info.method
            : (RawHTTPParser.methods[info.method] ?? null)
          : null;
      return handlers.onHeadersComplete({
        versionMajor: info.versionMajor,
        versionMinor: info.versionMinor,
        headers: info.headers,
        method,
        url: info.url ?? "",
        statusCode: info.statusCode,
        statusMessage: info.statusMessage,
        upgrade: info.upgrade,
        shouldKeepAlive: info.shouldKeepAlive,
      });
    };
    raw[RawHTTPParser.kOnBody] = (chunk: Buffer, offset: number, length: number) => {
      handlers.onBody(
        offset === 0 && length === chunk.length ? chunk : chunk.subarray(offset, offset + length),
      );
    };
    raw[RawHTTPParser.kOnMessageComplete] = () => {
      if (rejected === null) {
        handlers.onMessageComplete();
      }
    };
    raw[RawHTTPParser.kOnHeaders] = (trailers: string[]) => handlers.onTrailers(trailers);
    this.#raw = raw;
  }

  /** Parses `chunk`; returns how many bytes belong to HTTP (the rest follows an upgrade). */
  execute(chunk: Buffer): number | Error {
    const result = this.#raw.execute(chunk);
    if (result instanceof Error) {
      return parseError(result, this.#consumed);
    }
    this.#consumed += result;
    return result;
  }

  /** Signals end of input: completes a read-until-close body, or reports a truncated message. */
  finish(): Error | undefined {
    const result = this.#raw.finish();
    return result instanceof Error ? parseError(result, this.#consumed) : undefined;
  }
}

// The HTTP/1.1 wire format as the gateway's client speaks it: serialising a
// request head, parsing a response head, and decoding a response body framed by
// Content-Length, chunked transfer coding (with trailers) or connection close.
// Every parser takes bytes in whatever pieces they arrive, one byte included.
import type { HeaderList } from "./protocol";

/** Largest response head (status line + headers) accepted. */
const MAX_HEAD_BYTES = 64 * 1024;
/** Largest chunk-size or trailer line accepted. */
const MAX_LINE_BYTES = 8 * 1024;

const encoder = new TextEncoder();

/** A malformed or oversized message from the server. */
export class HttpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpParseError";
  }
}

/** A parsed response status line and header block. */
export interface ResponseHead {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: HeaderList;
}

/** A growable byte buffer. */
export class ByteBuffer {
  #bytes = new Uint8Array(256);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): void {
    if (this.#length + chunk.length > this.#bytes.length) {
      let capacity = this.#bytes.length * 2;
      while (capacity < this.#length + chunk.length) {
        capacity *= 2;
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = grown;
    }
    this.#bytes.set(chunk, this.#length);
    this.#length += chunk.length;
  }

  at(index: number): number {
    return this.#bytes[index];
  }

  /** A copy of bytes `[start, end)`. */
  slice(start: number, end = this.#length): Uint8Array {
    return this.#bytes.slice(start, end);
  }

  clear(): void {
    this.#length = 0;
  }
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return text;
}

/** Splits header lines (no status line) into a list, joining obsolete folded lines. */
function parseHeaderLines(lines: string[]): HeaderList {
  const headers: HeaderList = [];
  for (const line of lines) {
    if (line === "") {
      continue;
    }
    if ((line[0] === " " || line[0] === "\t") && headers.length > 0) {
      const last = headers[headers.length - 1];
      last[1] = `${last[1]} ${line.trim()}`.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new HttpParseError(`invalid header line "${line}"`);
    }
    const name = line.slice(0, colon);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new HttpParseError(`invalid header name "${name}"`);
    }
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return headers;
}

/** Collects a response head; anything after it is handed back as `rest`. */
export class ResponseHeadParser {
  #buffer = new ByteBuffer();
  #scanned = 0;

  /** Feeds bytes; returns the head once complete. Throws `HttpParseError`. */
  feed(chunk: Uint8Array): { head: ResponseHead; rest: Uint8Array } | null {
    this.#buffer.push(chunk);
    const buffer = this.#buffer;
    for (let i = this.#scanned; i < buffer.length; i++) {
      if (buffer.at(i) !== 0x0a) {
        continue;
      }
      // A blank line: "\n\n" or "\n\r\n".
      let end = -1;
      if (i >= 1 && buffer.at(i - 1) === 0x0a) {
        end = i + 1;
      } else if (i >= 2 && buffer.at(i - 1) === 0x0d && buffer.at(i - 2) === 0x0a) {
        end = i + 1;
      }
      if (end !== -1) {
        const head = parseHead(latin1(buffer.slice(0, end)));
        const rest = buffer.slice(end);
        buffer.clear();
        this.#scanned = 0;
        return { head, rest };
      }
    }
    this.#scanned = buffer.length;
    if (buffer.length > MAX_HEAD_BYTES) {
      throw new HttpParseError("response head too large");
    }
    return null;
  }
}

function parseHead(text: string): ResponseHead {
  // Tolerate blank lines before the status line.
  const lines = text.replace(/^(\r?\n)+/, "").split(/\r?\n/);
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/(\d\.\d) (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!match) {
    throw new HttpParseError(`invalid status line "${statusLine}"`);
  }
  return {
    httpVersion: match[1],
    status: Number(match[2]),
    statusText: match[3] ?? "",
    headers: parseHeaderLines(lines),
  };
}

/** Every value of header `name` (case-insensitive), in order. */
export function headerValues(headers: HeaderList, name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
}

/** The first value of header `name`, or null. */
export function headerValue(headers: HeaderList, name: string): string | null {
  return headerValues(headers, name)[0] ?? null;
}

/** How a response body is delimited. */
export type BodyFraming =
  | { kind: "none" }
  | { kind: "length"; length: number }
  | { kind: "chunked" }
  | { kind: "close" };

/** The body framing RFC 9112 §6.3 gives a response to `method`. Throws on conflicting lengths. */
export function responseFraming(method: string, head: ResponseHead): BodyFraming {
  const { status, headers } = head;
  if (method === "HEAD" || status < 200 || status === 204 || status === 304) {
    return { kind: "none" };
  }
  const codings = headerValues(headers, "transfer-encoding")
    .flatMap((value) => value.split(","))
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "");
  if (codings.length > 0) {
    return codings[codings.length - 1] === "chunked" ? { kind: "chunked" } : { kind: "close" };
  }
  const lengths = new Set(
    headerValues(headers, "content-length").flatMap((value) =>
      value.split(",").map((part) => part.trim()),
    ),
  );
  if (lengths.size === 0) {
    return { kind: "close" };
  }
  if (lengths.size > 1) {
    throw new HttpParseError("conflicting content-length values");
  }
  const [length] = lengths;
  if (!/^\d+$/.test(length)) {
    throw new HttpParseError(`invalid content-length "${length}"`);
  }
  return { kind: "length", length: Number(length) };
}

type ChunkState = "size" | "data" | "data-end" | "trailers" | "done";

/** Decodes a body framed as `framing`, emitting payload bytes as they arrive. */
export class BodyDecoder {
  /** Trailer fields of a chunked body, once it is complete. */
  trailers: HeaderList = [];
  #framing: BodyFraming;
  #remaining: number;
  #state: ChunkState = "size";
  #line = new ByteBuffer();
  #trailerLines: string[] = [];
  #done: boolean;

  constructor(framing: BodyFraming) {
    this.#framing = framing;
    this.#remaining = framing.kind === "length" ? framing.length : 0;
    this.#done = framing.kind === "none" || (framing.kind === "length" && framing.length === 0);
  }

  /** True once the whole body has been read. */
  get done(): boolean {
    return this.#done;
  }

  /**
   * Feeds bytes; payload goes to `onData`. Returns the bytes after the end of
   * the body (empty unless the body just ended). Throws `HttpParseError`.
   */
  feed(chunk: Uint8Array, onData: (data: Uint8Array) => void): Uint8Array {
    if (this.#done) {
      return chunk;
    }
    switch (this.#framing.kind) {
      case "close":
        if (chunk.length > 0) {
          onData(chunk);
        }
        return new Uint8Array(0);
      case "length": {
        const take = Math.min(this.#remaining, chunk.length);
        if (take > 0) {
          onData(chunk.subarray(0, take));
        }
        this.#remaining -= take;
        if (this.#remaining === 0) {
          this.#done = true;
        }
        return chunk.subarray(take);
      }
      case "chunked":
        return this.#feedChunked(chunk, onData);
      default:
        return chunk;
    }
  }

  /** The connection ended. Throws when the framing says more was due. */
  finish(): void {
    if (this.#framing.kind === "close") {
      this.#done = true;
    }
    if (!this.#done) {
      throw new HttpParseError("connection closed before the response body ended");
    }
  }

  #feedChunked(chunk: Uint8Array, onData: (data: Uint8Array) => void): Uint8Array {
    let i = 0;
    while (i < chunk.length && this.#state !== "done") {
      if (this.#state === "data") {
        const take = Math.min(this.#remaining, chunk.length - i);
        onData(chunk.subarray(i, i + take));
        i += take;
        this.#remaining -= take;
        if (this.#remaining === 0) {
          this.#state = "data-end";
        }
        continue;
      }
      // The other states read a line.
      const byte = chunk[i++];
      if (byte !== 0x0a) {
        this.#line.push(chunk.subarray(i - 1, i));
        if (this.#line.length > MAX_LINE_BYTES) {
          throw new HttpParseError("chunked framing line too long");
        }
        continue;
      }
      let line = latin1(this.#line.slice(0));
      this.#line.clear();
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.#endLine(line);
    }
    if (this.#state === "done") {
      this.#done = true;
    }
    return chunk.subarray(i);
  }

  #endLine(line: string): void {
    switch (this.#state) {
      case "size": {
        const size = line.split(";")[0].trim();
        if (!/^[0-9a-fA-F]{1,12}$/.test(size)) {
          throw new HttpParseError(`invalid chunk size "${line}"`);
        }
        this.#remaining = parseInt(size, 16);
        this.#state = this.#remaining === 0 ? "trailers" : "data";
        return;
      }
      case "data-end":
        if (line !== "") {
          throw new HttpParseError("missing CRLF after chunk data");
        }
        this.#state = "size";
        return;
      case "trailers":
        if (line === "") {
          this.trailers = parseHeaderLines(this.#trailerLines);
          this.#state = "done";
        } else {
          this.#trailerLines.push(line);
        }
        return;
      default:
        return;
    }
  }
}

/** Hop-by-hop request headers the gateway never forwards (it sets its own framing and host). */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
  "expect",
]);

/** True for a hop-by-hop header name (`proxy-*` included) that must not cross the gateway. */
export function isHopByHopHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("proxy-") || DROPPED_REQUEST_HEADERS.has(lower);
}

/** Serialises a request head (with the gateway's own `Host`, `Connection` and `Content-Length`). */
export function serializeRequestHead(
  method: string,
  target: string,
  serverPort: number,
  headers: HeaderList,
  bodyLength: number | null,
): Uint8Array {
  let head = `${method} ${target} HTTP/1.1\r\nHost: localhost:${serverPort}\r\nConnection: close\r\n`;
  for (const [name, value] of headers) {
    if (!isHopByHopHeader(name) && !/[\r\n]/.test(name + value)) {
      head += `${name}: ${value}\r\n`;
    }
  }
  if (bodyLength !== null) {
    head += `Content-Length: ${bodyLength}\r\n`;
  }
  return encoder.encode(`${head}\r\n`);
}

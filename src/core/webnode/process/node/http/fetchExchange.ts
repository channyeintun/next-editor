// Carries a `ClientRequest` to a host outside webnode with `globalThis.fetch`,
// since a browser has no raw sockets. The request keeps a stand-in socket so
// it emits `socket`, `response`, `timeout`, `error` and `close` as Node does.
// Headers `fetch` forbids are dropped; the body is buffered until the request
// ends (a streamed upload needs HTTP/2 in Chrome and would freeze the headers
// early); `redirect: "manual"` lets the caller see a 3xx; a rejected fetch
// becomes `ECONNREFUSED` with the original error as `cause`. The browser has
// already decoded the response body, so its Content-Encoding and
// Content-Length are not passed on with it.
import { errnoOf } from "../../../errors";
import { runtime } from "../../runtime";
import { Buffer } from "../buffer";
import { unsupported } from "../net/errors";
import { Socket } from "../net/socket";
import { STATUS_CODES } from "./common";
import { IncomingMessage, type HttpSocket } from "./incoming";

/** The request side the exchange drives (a `ClientRequest`). */
interface ExchangeRequest {
  method: string;
  _header: string | null;
  host: string;
  socket: HttpSocket | null;
  getHeaders(): Record<string, unknown>;
  emit(event: string): boolean;
}

type WriteCallback = (error?: Error | null) => void;
type ResponseWiring = (socket: HttpSocket, res: IncomingMessage) => number;

/** Request headers `fetch` will not take from a script. */
const FORBIDDEN_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

function forbidden(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-");
}

/** The response, pulling the next body chunk only when the reader wants it. */
class FetchResponse extends IncomingMessage {
  onRead: (() => void) | null = null;

  override _read(): void {
    super._read();
    const resume = this.onRead;
    this.onRead = null;
    resume?.();
  }
}

/** `fetch` behind a `ClientRequest`. */
export class FetchExchange {
  /** The stand-in socket the request reports; it carries no bytes. */
  readonly socket: HttpSocket;
  readonly #req: ExchangeRequest;
  readonly #url: string;
  readonly #controller = new AbortController();
  readonly #chunks: Uint8Array[] = [];
  #bodyEnded = false;
  #started = false;
  #fetching = false;
  #cancelled = false;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #ref: { unref(): void } | null = null;
  readonly #respondTo: ResponseWiring;

  /** `respondTo` wires a response to the request as the HTTP client does; it returns 1 to skip the body. */
  constructor(req: ExchangeRequest, url: string, respondTo: ResponseWiring) {
    this.#req = req;
    this.#url = url;
    this.#respondTo = respondTo;
    this.socket = new Socket() as HttpSocket;
    // However the exchange ends (the response read, or it or the request
    // destroyed), the fetch and its body reader stop with the socket.
    this.socket.once("close", () => this.cancel());
  }

  /** Takes body bytes the request writes (its head is ignored: fetch builds its own). */
  write(
    data: string | Uint8Array,
    encoding?: BufferEncoding | null,
    callback?: WriteCallback | null,
  ): boolean {
    const bytes = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
    if (bytes.length > 0) {
      this.#chunks.push(bytes.slice());
    }
    if (callback) {
      queueMicrotask(() => callback());
    }
    return true;
  }

  /** The request ended: send it now if it is buffered. */
  endBody(): void {
    if (this.#bodyEnded) {
      return;
    }
    this.#bodyEnded = true;
    if (this.#started) {
      this.#fetch();
    }
  }

  /** The request has its (stand-in) socket: send once the body is known. */
  start(): void {
    this.#started = true;
    this.#ref = runtime();
    runtime().ref();
    if (this.#bodyEnded) {
      this.#fetch();
      return;
    }
    // fetch drops Expect and only sends once the body has ended, while a
    // caller that asked for 100-continue writes the body after 'continue'.
    // The browser deals with the expectation itself, so go ahead at once.
    const expect = this.#req.getHeaders().expect;
    if (typeof expect === "string" && expect.toLowerCase() === "100-continue") {
      queueMicrotask(() => {
        if (!this.#cancelled) {
          this.#req.emit("continue");
        }
      });
    }
  }

  /** Aborts the fetch and the response body. */
  cancel(): void {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    this.#controller.abort();
    this.#reader?.cancel().catch(() => {});
    this.#release();
  }

  #release(): void {
    const held = this.#ref;
    this.#ref = null;
    held?.unref();
  }

  #headers(): Headers {
    const headers = new Headers();
    const head = this.#req._header;
    const lines: [string, string][] = [];
    if (head !== null) {
      for (const line of head.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          lines.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
        }
      }
    } else {
      for (const [name, value] of Object.entries(this.#req.getHeaders())) {
        for (const item of Array.isArray(value) ? value : [value]) {
          lines.push([name, String(item)]);
        }
      }
    }
    for (const [name, value] of lines) {
      if (forbidden(name)) {
        continue;
      }
      try {
        headers.append(name, value);
      } catch {
        // A value fetch rejects is dropped, like a forbidden name.
      }
    }
    return headers;
  }

  #fetch(follow = false): void {
    if (this.#cancelled || (this.#fetching && !follow)) {
      return;
    }
    this.#fetching = true;
    const method = this.#req.method;
    const init: RequestInit = {
      method,
      headers: this.#headers(),
      redirect: follow ? "follow" : "manual",
      signal: this.#controller.signal,
    };
    if (method !== "GET" && method !== "HEAD" && this.#chunks.length > 0) {
      init.body = Buffer.concat(this.#chunks);
    }
    let pending: Promise<Response>;
    try {
      pending = globalThis.fetch(this.#url, init);
    } catch (error) {
      this.#fail(error);
      return;
    }
    pending.then(
      (response) => this.#respond(response, follow),
      (error: unknown) => this.#fail(error),
    );
  }

  #fail(error: unknown): void {
    if (this.#cancelled) {
      return;
    }
    this.socket.destroy(this.#connectError(error));
  }

  #connectError(cause: unknown): Error {
    const url = new URL(this.#url);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(
      `connect ECONNREFUSED ${this.#req.host}:${port} (fetch ${this.#url} failed: ${detail})`,
      { cause },
    ) as Error & Record<string, unknown>;
    error.code = "ECONNREFUSED";
    error.errno = -errnoOf("ECONNREFUSED");
    error.syscall = "connect";
    error.address = this.#req.host;
    error.port = port;
    return error;
  }

  #respond(response: Response, followed: boolean): void {
    if (this.#cancelled) {
      response.body?.cancel().catch(() => {});
      return;
    }
    if (response.type === "opaqueredirect") {
      const method = this.#req.method;
      if (!followed && (method === "GET" || method === "HEAD")) {
        // The browser hides a redirect's status and Location from scripts;
        // a safe method can be followed instead.
        this.#fetch(true);
        return;
      }
      this.socket.destroy(
        unsupported(
          `A ${response.status || 3}xx redirect answering ${method} ${this.#url}`,
          "the browser hides a redirect's status and Location header from fetch",
        ),
      );
      return;
    }
    const socket = this.socket;
    const res = new FetchResponse(socket);
    res.httpVersionMajor = 1;
    res.httpVersionMinor = 1;
    res.httpVersion = "1.1";
    const raw: string[] = [];
    const setCookies =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    // The body bytes are the decoded ones: an encoding header would make a
    // client gunzip them again, and the length is the encoded size (when the
    // encoding is hidden from scripts it may still have been applied).
    const decodedBody = response.body !== null && this.#req.method !== "HEAD";
    response.headers.forEach((value, name) => {
      if (name === "set-cookie" && setCookies.length > 0) {
        return;
      }
      if (decodedBody && (name === "content-encoding" || name === "content-length")) {
        return;
      }
      raw.push(name, value);
    });
    for (const cookie of setCookies) {
      raw.push("set-cookie", cookie);
    }
    res._addHeaderLines(raw, raw.length);
    res.statusCode = response.status;
    res.statusMessage = response.statusText || STATUS_CODES[response.status] || "";
    const req = this.#req as unknown as { res: IncomingMessage | null };
    if (req.res) {
      return;
    }
    const skip = this.#respondTo(socket, res);
    if (skip !== 0 || response.body === null) {
      response.body?.cancel().catch(() => {});
      res.complete = true;
      res.push(null);
      return;
    }
    // A response destroyed while the pump waits for a read must wake it.
    res.once("close", () => {
      const resume = res.onRead;
      res.onRead = null;
      resume?.();
    });
    void this.#pump(response.body.getReader(), res);
  }

  async #pump(reader: ReadableStreamDefaultReader<Uint8Array>, res: FetchResponse): Promise<void> {
    this.#reader = reader;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.#cancelled || res.destroyed) {
          reader.cancel().catch(() => {});
          return;
        }
        if (done) {
          res.complete = true;
          res.push(null);
          return;
        }
        this.socket._unrefTimer();
        if (!res.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) {
          await new Promise<void>((resolve) => {
            res.onRead = resolve;
          });
        }
      }
    } catch (error) {
      if (!this.#cancelled) {
        this.socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

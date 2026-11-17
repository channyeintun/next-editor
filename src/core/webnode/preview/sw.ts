// The preview origin's service worker. It answers every same-origin request
// (except the host's own `/__webnode__/` files) by asking the gateway in the
// kernel worker over a control port that a window hands it, and forwards the
// page's WebSockets to the gateway. It also keeps the preview's cookies
// (cookieJar.ts), since a service worker's responses cannot set real ones, and
// a copy of them in its Cache Storage, since the browser stops idle workers.
// Bundled on its own into `/__webnode__/sw.js`, so it imports nothing but
// types, constants and the self-contained cookie jar.
import { PREVIEW_CONNECT_HTML, servedEditorOrigin } from "./connectPage";
import { CookieJar } from "./cookieJar";
import { PREVIEW_RESERVED_PREFIX, isMessageOfType } from "./protocol";
import type {
  AttachMessage,
  FromGatewayMessage,
  GatewayRequestMessage,
  HeaderList,
  NeedPortMessage,
  SocketCloseEvent,
  SocketErrorEvent,
  ToGatewayMessage,
  WebSocketOpenMessage,
} from "./protocol";

// ── the few ServiceWorker globals used (the project's only lib is DOM) ─────

interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request;
  readonly clientId: string;
  respondWith(response: Response | Promise<Response>): void;
}

interface SwClient {
  readonly id: string;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

interface SwExtendableMessageEvent extends SwExtendableEvent {
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
  readonly source: SwClient | MessagePort | ServiceWorker | null;
}

interface SwClients {
  get(id: string): Promise<SwClient | undefined>;
  claim(): Promise<void>;
}

/** The part of `CacheStorage` the cookie jar's copy uses. */
interface SwCaches {
  open(name: string): Promise<{
    match(key: string): Promise<Response | undefined>;
    put(key: string, response: Response): Promise<void>;
  }>;
}

/** The parts of `ServiceWorkerGlobalScope` this worker uses. */
export interface PreviewServiceWorkerScope {
  readonly location: { readonly origin: string; readonly host: string; readonly hostname: string };
  readonly clients: SwClients;
  /** Absent where the browser gives the worker no Cache Storage: the jar is then memory only. */
  readonly caches?: SwCaches;
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "install" | "activate",
    listener: (event: SwExtendableEvent) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: SwFetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: SwExtendableMessageEvent) => void): void;
}

/** Timings, overridable by tests. */
export interface PreviewServiceWorkerTimings {
  /**
   * Silence after which a control port is pinged before use, and how often a
   * port with requests in flight is checked (so a dead gateway fails them).
   */
  idleMs: number;
  /** How long a ping may take before the port counts as dead. */
  pingTimeoutMs: number;
  /** How long a subresource waits for a window to attach a port. */
  attachTimeoutMs: number;
}

const DEFAULT_TIMINGS: PreviewServiceWorkerTimings = {
  idleMs: 10_000,
  pingTimeoutMs: 1_000,
  attachTimeoutMs: 3_000,
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const ISOLATION_HEADERS: HeaderList = [
  ["Cross-Origin-Embedder-Policy", "require-corp"],
  ["Cross-Origin-Resource-Policy", "cross-origin"],
];

function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: [
      ["Content-Type", "text/plain; charset=utf-8"],
      ["Cache-Control", "no-store"],
      ...ISOLATION_HEADERS,
    ],
  });
}

/** Where the cookie jar's copy lives in Cache Storage. */
const JAR_CACHE = "webnode-preview";
const JAR_KEY = `${PREVIEW_RESERVED_PREFIX}cookie-jar`;

/**
 * The preview's cookie jar and its copy in Cache Storage. The copy is read
 * once when the worker starts; every request waits for that, so a restarted
 * worker sends the cookies the stopped one had.
 */
class PersistentJar {
  readonly #jar: CookieJar;
  readonly #caches: SwCaches | undefined;
  readonly #key: string;
  readonly ready: Promise<void>;
  #saving: Promise<void> = Promise.resolve();

  constructor(location: PreviewServiceWorkerScope["location"], caches: SwCaches | undefined) {
    const jar = new CookieJar(location.hostname);
    const key = new URL(JAR_KEY, location.origin).href;
    this.#jar = jar;
    this.#caches = caches;
    this.#key = key;
    this.ready = (async () => {
      try {
        const stored = await (await caches?.open(JAR_CACHE))?.match(key);
        if (stored) {
          jar.restore(await stored.json());
        }
      } catch {
        // No copy, or one that does not read: the jar starts empty.
      }
    })();
  }

  /** The `Cookie` header for a request to `path`, once the stored copy is in. */
  async header(path: string): Promise<string | null> {
    await this.ready;
    return this.#jar.header(path);
  }

  /** Stores a response's `Set-Cookie` lines and updates the copy. */
  store(lines: string[], path: string): void {
    if (lines.length === 0) {
      return;
    }
    this.#jar.store(lines, path);
    const caches = this.#caches;
    if (!caches) {
      return;
    }
    // One write at a time, so an older copy never lands after a newer one.
    this.#saving = this.#saving.then(async () => {
      try {
        const cache = await caches.open(JAR_CACHE);
        await cache.put(
          this.#key,
          new Response(JSON.stringify(this.#jar.entries()), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      } catch {
        // Not kept: the cookies last as long as this worker does.
      }
    });
  }
}

/**
 * The `Referer` the browser would send with `request` (a request to `origin`),
 * by its referrer policy, or null for none. The network adds it only after a
 * service worker, so the request here does not carry it.
 */
export function refererFor(request: Request, origin: string): string | null {
  const referrer = request.referrer;
  if (!referrer || referrer === "about:client") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  const sameOrigin = url.origin === origin;
  switch (request.referrerPolicy) {
    case "no-referrer":
      return null;
    case "same-origin":
      return sameOrigin ? referrer : null;
    case "origin":
    case "strict-origin":
      return `${url.origin}/`;
    case "unsafe-url":
    case "no-referrer-when-downgrade":
      return referrer;
    default:
      // strict-origin-when-cross-origin (the default) and origin-when-cross-origin.
      return sameOrigin ? referrer : `${url.origin}/`;
  }
}

interface Pending {
  resolve(response: Response): void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** The request's path, for the cookies its response sets. */
  path: string;
}

/** One control port to the gateway: its requests in flight and its liveness. */
class ControlLink {
  readonly port: MessagePort;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #pongs = new Map<number, () => void>();
  #lastHeard = Date.now();
  #ping: Promise<boolean> | null = null;
  #watchdog: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  /** Replaced by a newer port: closes once its last request is done. */
  #retired = false;
  readonly #timings: PreviewServiceWorkerTimings;
  readonly #jar: PersistentJar;
  readonly #location: PreviewServiceWorkerScope["location"];
  readonly #onPortClose = () => this.close();

  constructor(
    port: MessagePort,
    timings: PreviewServiceWorkerTimings,
    jar: PersistentJar,
    location: PreviewServiceWorkerScope["location"],
  ) {
    this.port = port;
    this.#timings = timings;
    this.#jar = jar;
    this.#location = location;
    port.onmessage = (event: MessageEvent<FromGatewayMessage>) => this.#onMessage(event.data);
    // Where MessagePort reports its peer closing (the kernel worker ended),
    // the link fails what it has in flight at once.
    port.addEventListener("close", this.#onPortClose);
    port.start();
  }

  /**
   * True when the gateway answered recently or answers a ping now. `probe`
   * always pings: a page load must not be sent to a runtime that has just gone.
   */
  isAlive(probe = false): Promise<boolean> {
    if (this.#closed) {
      return Promise.resolve(false);
    }
    if (!probe && Date.now() - this.#lastHeard < this.#timings.idleMs) {
      return Promise.resolve(true);
    }
    this.#ping ??= new Promise<boolean>((resolve) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pongs.delete(id);
        resolve(false);
      }, this.#timings.pingTimeoutMs);
      this.#pongs.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
      this.#post({ type: "ping", id });
    }).finally(() => {
      this.#ping = null;
    });
    return this.#ping;
  }

  /** Sends a WebSocket's port on to the gateway, with the cookies the browser would send. */
  openSocket(url: string, protocols: string[], cookie: string | null, port: MessagePort): void {
    this.#post(
      { type: "ws-connect", url, protocols, pageHost: this.#location.host, cookie, port },
      [port],
    );
  }

  /** Forwards `request`; resolves with the response once its head arrives. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const headers: HeaderList = [];
    request.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "cookie") {
        headers.push([name, value]);
      }
    });
    // The browser keeps its Sec-Fetch-* headers from a service worker, and
    // servers read them (Vite decides from Sec-Fetch-Dest whether a path with
    // an unknown extension is a module to transform), so they are restated.
    headers.push(
      ["Sec-Fetch-Dest", request.destination || "empty"],
      ["Sec-Fetch-Mode", request.mode],
      ["Sec-Fetch-Site", "same-origin"],
    );
    // Origin and Referer are added by the network after a service worker, and
    // servers check them (CSRF): they are restated as the browser sends them
    // on a same-origin request, and the gateway restates them on the server's
    // own origin.
    if (method !== "GET" && method !== "HEAD" && !request.headers.has("origin")) {
      headers.push(["Origin", this.#location.origin]);
    }
    const referer = refererFor(request, this.#location.origin);
    if (referer !== null && !request.headers.has("referer")) {
      headers.push(["Referer", referer]);
    }
    if (request.credentials !== "omit") {
      const cookie = await this.#jar.header(url.pathname);
      if (cookie !== null) {
        headers.push(["Cookie", cookie]);
      }
    }
    const body = method === "GET" || method === "HEAD" ? null : await request.arrayBuffer();
    const id = this.#nextId++;
    const message: GatewayRequestMessage = {
      type: "request",
      id,
      method,
      url: url.pathname + url.search,
      headers,
      body,
      pageHost: this.#location.host,
    };
    if (this.#closed) {
      return textResponse(502, "Bad Gateway: the preview lost its connection to the runtime");
    }
    return new Promise<Response>((resolve) => {
      this.#pending.set(id, { resolve, controller: null, path: url.pathname });
      this.#post(message, body ? [body] : []);
      this.#watch();
    });
  }

  /** Closes the port once no request is in flight on it (a newer port took over). */
  retire(): void {
    this.#retired = true;
    if (this.#pending.size === 0) {
      this.close();
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stopWatching();
    for (const [id, pending] of this.#pending) {
      this.#fail(id, pending, "the preview lost its connection to the runtime");
    }
    this.port.removeEventListener("close", this.#onPortClose);
    this.port.onmessage = null;
    this.port.close();
  }

  /**
   * While requests are in flight, checks every `idleMs` that the gateway still
   * answers, so a gateway that went away (disposed, its worker terminated)
   * fails them instead of leaving them hanging. A slow server is not silence:
   * the gateway itself answers the ping.
   */
  #watch(): void {
    if (this.#watchdog !== null) {
      return;
    }
    this.#watchdog = setInterval(() => {
      void this.isAlive().then((alive) => {
        if (!alive) {
          this.close();
        }
      });
    }, this.#timings.idleMs);
  }

  #stopWatching(): void {
    if (this.#watchdog !== null) {
      clearInterval(this.#watchdog);
      this.#watchdog = null;
    }
  }

  /** Bookkeeping once request `id` is done. */
  #settle(id: number): void {
    this.#pending.delete(id);
    if (this.#pending.size === 0) {
      this.#stopWatching();
      if (this.#retired) {
        this.close();
      }
    }
  }

  #post(message: ToGatewayMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer);
  }

  #fail(id: number, pending: Pending, message: string): void {
    this.#settle(id);
    if (pending.controller) {
      pending.controller.error(new TypeError(message));
    } else {
      pending.resolve(textResponse(502, `Bad Gateway: ${message}`));
    }
  }

  #onMessage(message: FromGatewayMessage): void {
    this.#lastHeard = Date.now();
    if (message.type === "pong") {
      this.#pongs.get(message.id)?.();
      this.#pongs.delete(message.id);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) {
      return;
    }
    switch (message.type) {
      case "response-head": {
        const { id } = message;
        const setCookies: string[] = [];
        const headers: HeaderList = [];
        for (const [name, value] of message.headers) {
          if (name.toLowerCase() === "set-cookie") {
            setCookies.push(value);
          } else {
            headers.push([name, value]);
          }
        }
        this.#jar.store(setCookies, pending.path);
        const init: ResponseInit = {
          status: message.status,
          statusText: message.statusText,
          headers,
        };
        if (NULL_BODY_STATUSES.has(message.status)) {
          this.#settle(id);
          this.#post({ type: "cancel", id });
          pending.resolve(this.#response(null, init));
          return;
        }
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            pending.controller = controller;
          },
          cancel: () => {
            if (this.#pending.has(id)) {
              this.#settle(id);
              this.#post({ type: "cancel", id });
            }
          },
        });
        pending.resolve(this.#response(body, init));
        return;
      }
      case "response-chunk":
        pending.controller?.enqueue(new Uint8Array(message.chunk));
        return;
      case "response-end":
        this.#settle(message.id);
        pending.controller?.close();
        return;
      case "response-error":
        this.#fail(message.id, pending, message.message);
        return;
      default:
        return;
    }
  }

  #response(body: ReadableStream<Uint8Array> | null, init: ResponseInit): Response {
    try {
      return new Response(body, init);
    } catch (error) {
      // A status `Response` cannot carry (1xx) or a header it refuses.
      return textResponse(
        502,
        `Bad Gateway: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** True for a window client (a message's `source` may also be a port or a worker). */
function isClient(source: SwExtendableMessageEvent["source"]): source is SwClient {
  return (
    source !== null &&
    typeof (source as Partial<SwClient>).id === "string" &&
    typeof source.postMessage === "function"
  );
}

/** Installs the preview service worker's listeners on `scope`. */
export function installPreviewServiceWorker(
  scope: PreviewServiceWorkerScope,
  timings: PreviewServiceWorkerTimings = DEFAULT_TIMINGS,
): void {
  let link: ControlLink | null = null;
  let attachWaiters: (() => void)[] = [];
  const jar = new PersistentJar(scope.location, scope.caches);

  function attach(port: MessagePort): void {
    // The old link keeps serving what it already has in flight, then closes.
    link?.retire();
    link = new ControlLink(port, timings, jar, scope.location);
    const waiters = attachWaiters;
    attachWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  async function liveLink(probe = false): Promise<ControlLink | null> {
    const current = link;
    if (!current) {
      return null;
    }
    if (await current.isAlive(probe)) {
      return current;
    }
    if (link === current) {
      link = null;
      current.close();
    }
    return link;
  }

  /** The cookies a browser sends on a handshake to `url`: the jar's, for this origin's own host. */
  async function socketCookie(url: string): Promise<string | null> {
    try {
      const parsed = new URL(url);
      return parsed.host === scope.location.host ? await jar.header(parsed.pathname) : null;
    } catch {
      return null;
    }
  }

  function waitForAttach(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timings.attachTimeoutMs);
      attachWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function handle(event: SwFetchEvent): Promise<Response> {
    const { request } = event;
    // The editor may have restarted its runtime since the last page load: the
    // old one no longer answers, and the page must reconnect to the new one.
    let current = await liveLink(request.mode === "navigate");
    if (!current) {
      if (request.mode === "navigate") {
        return new Response(PREVIEW_CONNECT_HTML, {
          status: 200,
          headers: [
            ["Content-Type", "text/html; charset=utf-8"],
            ["Cache-Control", "no-store"],
            // As the host's own copy: only the editor may frame the connect page.
            ["Content-Security-Policy", `frame-ancestors ${servedEditorOrigin()}`],
            ...ISOLATION_HEADERS,
          ],
        });
      }
      const client = event.clientId ? await scope.clients.get(event.clientId) : undefined;
      if (client) {
        const ask: NeedPortMessage = { type: "webnode:need-port" };
        const attached = waitForAttach();
        client.postMessage(ask);
        await attached;
        current = await liveLink();
      }
      if (!current) {
        return textResponse(
          503,
          "Service Unavailable: the preview is not connected to the runtime.",
        );
      }
    }
    return current.fetch(request);
  }

  scope.addEventListener("install", (event) => {
    event.waitUntil(scope.skipWaiting());
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(scope.clients.claim());
  });

  scope.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== scope.location.origin || url.pathname.startsWith(PREVIEW_RESERVED_PREFIX)) {
      return; // The network answers.
    }
    event.respondWith(handle(event));
  });

  scope.addEventListener("message", (event) => {
    const data = event.data;
    if (isMessageOfType<AttachMessage>(data, "webnode:attach")) {
      const control = data.control ?? event.ports[0];
      if (!control) {
        return;
      }
      attach(control);
      data.reply?.postMessage({ type: "webnode:attached" });
      return;
    }
    if (isMessageOfType<WebSocketOpenMessage>(data, "webnode:ws")) {
      const port = data.port ?? event.ports[0];
      if (!port) {
        return;
      }
      const source = event.source;
      event.waitUntil(
        (async () => {
          let current = await liveLink();
          if (!current && isClient(source)) {
            // The worker was stopped and restarted (its port lives only in
            // memory): ask the page for a fresh port, as a request would.
            const ask: NeedPortMessage = { type: "webnode:need-port" };
            const attached = waitForAttach();
            source.postMessage(ask);
            await attached;
            current = await liveLink();
          }
          if (current) {
            current.openSocket(data.url, data.protocols, await socketCookie(data.url), port);
            return;
          }
          const error: SocketErrorEvent = { type: "error" };
          const close: SocketCloseEvent = {
            type: "close",
            code: 1006,
            reason: "",
            wasClean: false,
          };
          port.postMessage(error);
          port.postMessage(close);
          port.close();
        })(),
      );
    }
  });
}

declare const ServiceWorkerGlobalScope: (abstract new () => unknown) | undefined;

if (
  typeof ServiceWorkerGlobalScope === "function" &&
  globalThis instanceof ServiceWorkerGlobalScope
) {
  installPreviewServiceWorker(globalThis as unknown as PreviewServiceWorkerScope);
}

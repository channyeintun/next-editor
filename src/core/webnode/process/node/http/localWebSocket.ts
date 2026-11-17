// The `WebSocket` a process opens to a server inside the runtime. The browser's
// own WebSocket would dial the visitor's machine, so a socket to a local host
// is carried over the runtime's own connection to the port, by the same
// RFC 6455 client the preview gateway uses (preview/websocket.ts), driven
// through a MessageChannel exactly as a preview page drives it.
import { openWebSocketBridge } from "../../../preview/websocket";
import type { FromGatewaySocketMessage } from "../../../preview/protocol";
import { runtime } from "../../runtime";
import { isLocalHost, loopbackFor } from "../net/ip";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const TOKEN = /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/;
const HANDLERS = ["open", "message", "error", "close"] as const;
type HandlerName = (typeof HANDLERS)[number];
type Handler = ((this: LocalWebSocket, event: Event) => unknown) | null;

const encoder = new TextEncoder();

function syntaxError(message: string): DOMException {
  return new DOMException(`Failed to construct 'WebSocket': ${message}`, "SyntaxError");
}

/** The ws:/wss: URL a socket is opened with (http:/https: mapped), as the WebSocket spec parses it. */
export function parseWebSocketUrl(url: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw syntaxError(`The URL '${String(url)}' is invalid.`);
  }
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw syntaxError(
      `The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${parsed.protocol.slice(0, -1)}' is not allowed.`,
    );
  }
  if (parsed.hash !== "") {
    throw syntaxError(`The URL contains a fragment identifier ('${parsed.hash}').`);
  }
  return parsed;
}

/** Whether a socket to `url` must reach a server inside the runtime. */
export function isLocalWebSocketUrl(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = parseWebSocketUrl(url);
  } catch {
    return false;
  }
  return isLocalHost(parsed.hostname);
}

function normalizeProtocols(protocols: string | readonly string[] | undefined): string[] {
  const list =
    protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols];
  const seen = new Set<string>();
  for (const protocol of list) {
    if (!TOKEN.test(protocol)) {
      throw syntaxError(`The subprotocol '${protocol}' is invalid.`);
    }
    const key = protocol.toLowerCase();
    if (seen.has(key)) {
      throw syntaxError(`The subprotocol '${protocol}' is duplicated.`);
    }
    seen.add(key);
  }
  return list;
}

function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  if (typeof CloseEvent === "function") {
    return new CloseEvent("close", { code, reason, wasClean });
  }
  const event = new Event("close");
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
    wasClean: { value: wasClean },
  });
  return event;
}

/** A WebSocket client (the WHATWG interface) to a port a process listens on. */
export class LocalWebSocket extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  #url: string;
  #origin: string;
  #state = CONNECTING;
  #protocol = "";
  #extensions = "";
  #binaryType: BinaryType = "blob";
  #buffered = 0;
  #port: MessagePort | null;
  #handlers: Record<HandlerName, Handler> = { open: null, message: null, error: null, close: null };
  #blobChain: Promise<void> | null = null;
  #release: () => void;

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    const resolved = parseWebSocketUrl(url);
    const list = normalizeProtocols(protocols);
    this.#url = resolved.href;
    this.#origin = resolved.origin;
    for (const type of HANDLERS) {
      this.addEventListener(type, (event) => this.#handlers[type]?.call(this, event));
    }
    // A socket keeps the process alive from construction until it closes.
    const rt = runtime();
    rt.ref();
    let released = false;
    this.#release = () => {
      if (!released) {
        released = true;
        rt.unref();
      }
    };
    const port =
      resolved.port !== "" ? Number(resolved.port) : resolved.protocol === "wss:" ? 443 : 80;
    const address = loopbackFor(resolved.hostname).address;
    const channel = new MessageChannel();
    this.#port = channel.port1;
    this.#port.onmessage = (event: MessageEvent<FromGatewaySocketMessage>) =>
      this.#onBridge(event.data);
    openWebSocketBridge({
      connect: (target) => runtime().net.connect(target, address),
      page: channel.port2,
      url: resolved.href,
      protocols: list,
      // The URL's own host is the "page host", so any local name reaches `port`.
      pageHost: resolved.host,
      serverPort: port,
    });
  }

  #onBridge(data: FromGatewaySocketMessage): void {
    if (this.#state === CLOSED) {
      return;
    }
    if (data.type === "open") {
      this.#state = OPEN;
      this.#protocol = data.protocol;
      this.#extensions = data.extensions;
      this.dispatchEvent(new Event("open"));
    } else if (data.type === "message") {
      if (this.#state !== OPEN) {
        return;
      }
      const payload =
        typeof data.data !== "string" && this.#binaryType === "blob"
          ? new Blob([data.data])
          : data.data;
      this.dispatchEvent(new MessageEvent("message", { data: payload, origin: this.#origin }));
    } else if (data.type === "sent") {
      this.#buffered = Math.max(0, this.#buffered - data.bytes);
    } else if (data.type === "error") {
      this.dispatchEvent(new Event("error"));
    } else if (data.type === "close") {
      this.#state = CLOSED;
      if (this.#port) {
        this.#port.onmessage = null;
        this.#port.close();
        this.#port = null;
      }
      this.#release();
      this.dispatchEvent(closeEvent(data.code, data.reason, data.wasClean));
    }
  }

  get url(): string {
    return this.#url;
  }
  get readyState(): number {
    return this.#state;
  }
  get protocol(): string {
    return this.#protocol;
  }
  get extensions(): string {
    return this.#extensions;
  }
  get bufferedAmount(): number {
    return this.#buffered;
  }
  get binaryType(): BinaryType {
    return this.#binaryType;
  }
  set binaryType(value: BinaryType) {
    if (value === "blob" || value === "arraybuffer") {
      this.#binaryType = value;
    }
  }
  get onopen(): Handler {
    return this.#handlers.open;
  }
  set onopen(value: Handler) {
    this.#handlers.open = typeof value === "function" ? value : null;
  }
  get onmessage(): Handler {
    return this.#handlers.message;
  }
  set onmessage(value: Handler) {
    this.#handlers.message = typeof value === "function" ? value : null;
  }
  get onerror(): Handler {
    return this.#handlers.error;
  }
  set onerror(value: Handler) {
    this.#handlers.error = typeof value === "function" ? value : null;
  }
  get onclose(): Handler {
    return this.#handlers.close;
  }
  set onclose(value: Handler) {
    this.#handlers.close = typeof value === "function" ? value : null;
  }

  send(...args: (string | ArrayBufferLike | Blob | ArrayBufferView)[]): void {
    if (args.length === 0) {
      throw new TypeError(
        "Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.",
      );
    }
    if (this.#state === CONNECTING) {
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
        "InvalidStateError",
      );
    }
    const data = args[0];
    let message: string | ArrayBuffer | Blob;
    let size: number;
    if (data instanceof ArrayBuffer) {
      message = data.slice(0);
      size = message.byteLength;
    } else if (ArrayBuffer.isView(data)) {
      message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
      size = message.byteLength;
    } else if (typeof Blob === "function" && data instanceof Blob) {
      message = data;
      size = data.size;
    } else {
      message = String(data);
      size = encoder.encode(message).length;
    }
    this.#buffered += size;
    if (this.#state !== OPEN) {
      return;
    }
    const port = this.#port;
    const post = (value: string | ArrayBuffer) => {
      if (port === null) {
        return;
      }
      if (typeof value === "string") {
        port.postMessage({ type: "send", data: value });
      } else {
        port.postMessage({ type: "send", data: value }, [value]);
      }
    };
    if (typeof message === "string" || message instanceof ArrayBuffer) {
      const ready = message;
      if (this.#blobChain) {
        this.#blobChain = this.#blobChain.then(() => post(ready));
      } else {
        post(ready);
      }
      return;
    }
    // A Blob is read first; later sends wait for it so the order holds.
    const read = message.arrayBuffer();
    const chain = (this.#blobChain ?? Promise.resolve()).then(() => read).then(post, () => {});
    this.#blobChain = chain;
    void chain.then(() => {
      if (this.#blobChain === chain) {
        this.#blobChain = null;
      }
    });
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined) {
      code = Number(code);
      if (!(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999))) {
        throw new DOMException(
          `Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
          "InvalidAccessError",
        );
      }
    }
    if (reason !== undefined) {
      reason = String(reason);
      if (encoder.encode(reason).length > 123) {
        throw new DOMException(
          "Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.",
          "SyntaxError",
        );
      }
    }
    if (this.#state === CLOSING || this.#state === CLOSED) {
      return;
    }
    const wasConnecting = this.#state === CONNECTING;
    this.#state = CLOSING;
    if (this.#port === null) {
      return;
    }
    if (wasConnecting) {
      this.#port.postMessage({ type: "close" });
    } else {
      this.#port.postMessage({
        type: "close",
        code: code === undefined && reason !== undefined ? 1000 : code,
        reason: reason ?? "",
      });
    }
  }
}

// The kernel-worker end of the preview: serves the requests and WebSockets a
// preview origin's service worker sends on a control port by opening
// connections to the server a process listens with. HTTP framing lives in
// httpExchange.ts, the WebSocket client in websocket.ts; this file wires ports.
import type { ByteChannel } from "../process/runtime";
import { createPreviewClientScript } from "./clientScript";
import { startHttpExchange } from "./httpExchange";
import type { PreviewCoep } from "./httpExchange";
import type { FromGatewayMessage, ToGatewayMessage } from "./protocol";
import { openWebSocketBridge } from "./websocket";

export interface PreviewGatewayOptions {
  /** Opens a connection to the server listening on `port`. Rejects with a SystemError ECONNREFUSED when nothing listens. */
  connect(port: number): Promise<ByteChannel>;
  /** Raw JavaScript the embedder wants in every HTML document ("" for none). Read on every response. */
  previewScript(): string;
  coep: PreviewCoep;
  forwardPreviewErrors: boolean | "exceptions-only";
  /** The editor's origin: the injected client talks to its parent only at this origin. */
  editorOrigin: string;
}

interface Link {
  port: MessagePort;
  exchanges: Map<number, { cancel(): void }>;
  onClose: () => void;
}

/** What the service worker is told about a request the gateway stops serving. */
const CLOSED_MESSAGE = "the preview gateway closed";

/** Serves preview control ports from the kernel worker. */
export class PreviewGateway {
  readonly #options: PreviewGatewayOptions;
  readonly #clientScript: string;
  readonly #links = new Set<Link>();
  /**
   * Open WebSocket bridges. They talk to the page over their own ports, so they
   * outlive the control port that brought them; only `dispose` ends them all.
   */
  readonly #sockets = new Set<{ dispose(): void }>();
  #disposed = false;

  /** How many WebSocket bridges are open. */
  get openSockets(): number {
    return this.#sockets.size;
  }

  constructor(options: PreviewGatewayOptions) {
    this.#options = options;
    this.#clientScript = createPreviewClientScript({
      forwardPreviewErrors: options.forwardPreviewErrors,
      editorOrigin: options.editorOrigin,
    });
  }

  /** Serves the requests that arrive on `controlPort` from the server listening on `serverPort`. */
  attach(controlPort: MessagePort, serverPort: number): void {
    if (this.#disposed) {
      controlPort.close();
      return;
    }
    const link: Link = {
      port: controlPort,
      exchanges: new Map(),
      // The service worker dropped this port (it was replaced, or the worker
      // stopped): its requests are dropped too, and the link is forgotten.
      onClose: () => this.#closeLink(link),
    };
    this.#links.add(link);
    controlPort.addEventListener("close", link.onClose);
    controlPort.onmessage = (event: MessageEvent<ToGatewayMessage>) => {
      this.#onMessage(link, serverPort, event.data);
    };
    controlPort.start();
  }

  /** Closes every control port and drops every open connection. */
  dispose(): void {
    this.#disposed = true;
    for (const link of this.#links) {
      this.#closeLink(link);
    }
    for (const socket of this.#sockets) {
      socket.dispose();
    }
    this.#sockets.clear();
  }

  /** Fails the link's requests in flight (so none hangs), then closes its port. */
  #closeLink(link: Link): void {
    if (!this.#links.delete(link)) {
      return;
    }
    link.port.removeEventListener("close", link.onClose);
    link.port.onmessage = null;
    for (const [id, exchange] of link.exchanges) {
      exchange.cancel();
      try {
        link.port.postMessage({
          type: "response-error",
          id,
          message: CLOSED_MESSAGE,
        } satisfies FromGatewayMessage);
      } catch {
        // The other end is gone already.
      }
    }
    link.exchanges.clear();
    link.port.close();
  }

  #onMessage(link: Link, serverPort: number, message: ToGatewayMessage): void {
    const post = (reply: FromGatewayMessage, transfer: Transferable[] = []) => {
      link.port.postMessage(reply, transfer);
    };
    switch (message.type) {
      case "ping":
        post({ type: "pong", id: message.id });
        return;
      case "cancel":
        link.exchanges.get(message.id)?.cancel();
        link.exchanges.delete(message.id);
        return;
      case "request": {
        const { id } = message;
        const options = this.#options;
        const clientScript = this.#clientScript;
        const exchange = startHttpExchange(
          {
            connect: (port) => options.connect(port),
            serverPort,
            scripts: () => [clientScript, options.previewScript()],
            clientScript,
            coep: options.coep,
          },
          {
            method: message.method,
            url: message.url,
            headers: message.headers,
            body: message.body ? new Uint8Array(message.body) : null,
            pageHost: message.pageHost ?? null,
          },
          {
            head: (status, statusText, headers) =>
              post({ type: "response-head", id, status, statusText, headers }),
            chunk: (bytes) => {
              const buffer = bytes.buffer as ArrayBuffer;
              const owned =
                bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength
                  ? buffer
                  : (bytes.slice().buffer as ArrayBuffer);
              post({ type: "response-chunk", id, chunk: owned }, [owned]);
            },
            end: () => {
              link.exchanges.delete(id);
              post({ type: "response-end", id });
            },
            error: (text) => {
              link.exchanges.delete(id);
              post({ type: "response-error", id, message: text });
            },
          },
        );
        link.exchanges.set(id, exchange);
        return;
      }
      case "ws-connect": {
        // A socket can fail before `openWebSocketBridge` returns (a bad URL or
        // port): then it is finished already and must not be kept.
        let bridge: { dispose(): void } | null = null;
        let finished = false;
        bridge = openWebSocketBridge({
          connect: (port) => this.#options.connect(port),
          page: message.port,
          url: message.url,
          protocols: message.protocols,
          pageHost: message.pageHost,
          cookie: message.cookie ?? null,
          serverPort,
          onFinished: () => {
            finished = true;
            if (bridge) {
              this.#sockets.delete(bridge);
            }
          },
        });
        if (!finished) {
          this.#sockets.add(bridge);
        }
        return;
      }
      default:
        return;
    }
  }
}

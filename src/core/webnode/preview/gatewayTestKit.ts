// Test support for the gateway: a fake kernel with scripted servers on ports,
// a control port driven like the service worker drives it, and helpers to read
// requests and responses. Only tests import this file.
import { createSystemError } from "../errors";
import type { ByteChannel } from "../process/runtime";
import { PreviewGateway } from "./gateway";
import type { PreviewGatewayOptions } from "./gateway";
import type { FromGatewayMessage, HeaderList, ToGatewayMessage } from "./protocol";
import { createChannelPair } from "./testChannels";
import type { LinkedChannel } from "./testChannels";

export const encoder = new TextEncoder();
/** The editor origin the test gateways are built for. */
export const EDITOR_ORIGIN = "https://editor.test";
export const decoder = new TextDecoder();

/** Latin-1 text of `bytes`. */
export function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The request a fake server received. */
export interface ReceivedRequest {
  head: string;
  requestLine: string;
  headers: HeaderList;
  body: Uint8Array;
}

/** Reads one HTTP request (head + Content-Length body) from `channel`. */
export function readRequest(channel: ByteChannel): Promise<ReceivedRequest> {
  return new Promise((resolve) => {
    let bytes: Uint8Array = new Uint8Array(0);
    channel.onData = (chunk) => {
      bytes = concat([bytes, chunk]);
      const text = latin1(bytes);
      const end = text.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      const head = text.slice(0, end);
      const [requestLine, ...lines] = head.split("\r\n");
      const headers: HeaderList = lines.map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      });
      const length = Number(
        headers.find(([name]) => name.toLowerCase() === "content-length")?.[1] ?? "0",
      );
      if (bytes.length - (end + 4) < length) {
        return;
      }
      channel.onData = null;
      resolve({ head, requestLine, headers, body: bytes.slice(end + 4, end + 4 + length) });
    };
  });
}

/** What a test sees of one response. */
export interface CollectedResponse {
  status: number;
  statusText: string;
  headers: HeaderList;
  body: Uint8Array;
  error: string | null;
  /** Every message for this request, in order. */
  messages: FromGatewayMessage[];
}

export function header(headers: HeaderList, name: string): string | null {
  return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
}

/** A gateway on a fake kernel, attached for server port 3000. */
export function createGatewayHarness(overrides: Partial<PreviewGatewayOptions> = {}) {
  const servers = new Map<number, (channel: LinkedChannel) => void>();
  const connections: LinkedChannel[] = [];
  let previewScript = "";
  const gateway = new PreviewGateway({
    connect: async (port) => {
      const serve = servers.get(port);
      if (!serve) {
        throw createSystemError("ECONNREFUSED", "connect");
      }
      const [client, server] = createChannelPair();
      connections.push(client);
      serve(server);
      return client;
    },
    previewScript: () => previewScript,
    coep: "require-corp",
    forwardPreviewErrors: false,
    editorOrigin: EDITOR_ORIGIN,
    ...overrides,
  });
  const channel = new MessageChannel();
  gateway.attach(channel.port1, 3000);
  const listeners = new Set<(message: FromGatewayMessage) => void>();
  channel.port2.onmessage = (event: MessageEvent<FromGatewayMessage>) => {
    for (const listener of listeners) {
      listener(event.data);
    }
  };
  let nextId = 1;

  function send(message: ToGatewayMessage, transfer: Transferable[] = []): void {
    channel.port2.postMessage(message, transfer);
  }

  /** Watches the messages for request `id`. */
  function watch(id: number, onMessage: (message: FromGatewayMessage) => void): () => void {
    const listener = (message: FromGatewayMessage) => {
      if (message.id === id) {
        onMessage(message);
      }
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Sends a request and resolves with the whole response. */
  function request(
    init: {
      method?: string;
      url?: string;
      headers?: HeaderList;
      body?: Uint8Array;
      pageHost?: string;
    } = {},
  ): Promise<CollectedResponse> & { id: number } {
    const id = nextId++;
    const promise = new Promise<CollectedResponse>((resolve) => {
      const result: CollectedResponse = {
        status: 0,
        statusText: "",
        headers: [],
        body: new Uint8Array(0),
        error: null,
        messages: [],
      };
      const parts: Uint8Array[] = [];
      const stop = watch(id, (message) => {
        result.messages.push(message);
        if (message.type === "response-head") {
          result.status = message.status;
          result.statusText = message.statusText;
          result.headers = message.headers;
        } else if (message.type === "response-chunk") {
          parts.push(new Uint8Array(message.chunk));
        } else if (message.type === "response-end" || message.type === "response-error") {
          stop();
          result.body = concat(parts);
          result.error = message.type === "response-error" ? message.message : null;
          resolve(result);
        }
      });
    });
    const body = init.body ? (init.body.slice().buffer as ArrayBuffer) : null;
    send(
      {
        type: "request",
        id,
        method: init.method ?? "GET",
        url: init.url ?? "/",
        headers: init.headers ?? [],
        body,
        ...(init.pageHost ? { pageHost: init.pageHost } : {}),
      },
      body ? [body] : [],
    );
    return Object.assign(promise, { id });
  }

  return {
    gateway,
    servers,
    connections,
    send,
    watch,
    request,
    /** Closes the service worker's end of the control port, as a replaced or stopped worker does. */
    closeControlPort(): void {
      channel.port2.onmessage = null;
      channel.port2.close();
    },
    setPreviewScript(source: string): void {
      previewScript = source;
    },
    /** Serves every connection on `port` by reading the request and calling `respond`. */
    serve(
      port: number,
      respond: (server: LinkedChannel, request: ReceivedRequest) => void | Promise<void>,
    ): ReceivedRequest[] {
      const received: ReceivedRequest[] = [];
      servers.set(port, (server) => {
        void readRequest(server).then((request) => {
          received.push(request);
          return respond(server, request);
        });
      });
      return received;
    },
    dispose(): void {
      gateway.dispose();
      channel.port2.onmessage = null;
      channel.port2.close();
    },
  };
}

/** Writes `parts` (strings are Latin-1/ASCII) one per microtask-delivered write. */
export function writeAll(channel: ByteChannel, parts: (string | Uint8Array)[]): void {
  for (const part of parts) {
    channel.write(typeof part === "string" ? encoder.encode(part) : part);
  }
}

/** Splits `text` into pieces of `size` bytes. */
export function pieces(data: string | Uint8Array, size: number): Uint8Array[] {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}

/** Resolves after pending microtasks and message deliveries settle. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

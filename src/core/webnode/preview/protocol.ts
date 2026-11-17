// Every message the preview pieces exchange: the editor page ⇄ the preview
// window, the preview window ⇄ its service worker, the service worker ⇄ the
// gateway in the kernel worker, and the gateway ⇄ a page's WebSocket object.
// Ports travel as message fields and are always transferred; so are body
// ArrayBuffers.

/** The path prefix the preview origin's host serves itself (never proxied). */
export const PREVIEW_RESERVED_PREFIX = "/__webnode__/";
/** Where the preview origin serves its service worker. */
export const PREVIEW_SERVICE_WORKER_PATH = "/__webnode__/sw.js";

// ── editor page ⇄ preview window ─────────────────────────────────────────────

/** Preview window → editor page: "give me a control port". Carries no secret. */
export interface PreviewConnectMessage {
  type: "webnode:preview-connect";
}

/** Editor page → preview window: the window's end of a new control port. */
export interface PreviewPortMessage {
  type: "webnode:preview-port";
  port: MessagePort;
  /** The editor's build (buildId.ts): the preview registers that build's service worker. */
  build?: string;
}

/** Preview window → editor page: a forwarded error report. */
export interface PreviewForwardedMessage {
  type: "webnode:preview-message";
  payload: Record<string, unknown>;
}

/** Editor page → preview window: reload yourself. */
export interface PreviewReloadMessage {
  type: "webnode:reload";
}

// ── preview window ⇄ service worker ──────────────────────────────────────────

/** Window → service worker: use `control` from now on; answer on `reply` when given. */
export interface AttachMessage {
  type: "webnode:attach";
  control: MessagePort;
  reply?: MessagePort;
}

/** Service worker → window (on the attach message's `reply` port). */
export interface AttachedMessage {
  type: "webnode:attached";
}

/** Service worker → window: "I have no control port; get me one". */
export interface NeedPortMessage {
  type: "webnode:need-port";
}

/** Window → service worker: open a WebSocket; events flow on `port`. */
export interface WebSocketOpenMessage {
  type: "webnode:ws";
  url: string;
  protocols: string[];
  port: MessagePort;
}

// ── service worker ⇄ gateway (control port) ──────────────────────────────────

/** One header line; a list keeps duplicates (`set-cookie`) and order. */
export type HeaderList = [name: string, value: string][];

export interface GatewayRequestMessage {
  type: "request";
  id: number;
  method: string;
  /** Path and query of the page's request. */
  url: string;
  headers: HeaderList;
  body: ArrayBuffer | null;
  /** The preview origin's host, so the gateway can restate the page's Origin and Referer as the server's. */
  pageHost?: string;
}

export interface GatewayCancelMessage {
  type: "cancel";
  id: number;
}

export interface GatewayPingMessage {
  type: "ping";
  id: number;
}

export interface GatewayWebSocketConnectMessage {
  type: "ws-connect";
  url: string;
  protocols: string[];
  /** The preview origin's host, so the gateway knows which URLs mean "this server". */
  pageHost: string;
  /** The preview's cookies for the socket's URL (`Cookie` on the handshake), when it has any. */
  cookie?: string | null;
  port: MessagePort;
}

/** Service worker → gateway. */
export type ToGatewayMessage =
  | GatewayRequestMessage
  | GatewayCancelMessage
  | GatewayPingMessage
  | GatewayWebSocketConnectMessage;

export interface GatewayResponseHeadMessage {
  type: "response-head";
  id: number;
  status: number;
  statusText: string;
  headers: HeaderList;
}

export interface GatewayResponseChunkMessage {
  type: "response-chunk";
  id: number;
  chunk: ArrayBuffer;
}

export interface GatewayResponseEndMessage {
  type: "response-end";
  id: number;
}

/** The exchange failed; before the head the service worker answers 502, after it the body errors. */
export interface GatewayResponseErrorMessage {
  type: "response-error";
  id: number;
  message: string;
}

export interface GatewayPongMessage {
  type: "pong";
  id: number;
}

/** Gateway → service worker. */
export type FromGatewayMessage =
  | GatewayResponseHeadMessage
  | GatewayResponseChunkMessage
  | GatewayResponseEndMessage
  | GatewayResponseErrorMessage
  | GatewayPongMessage;

// ── gateway ⇄ a page's WebSocket (the `webnode:ws` port) ─────────────────────

/** Gateway → socket: the handshake succeeded. */
export interface SocketOpenEvent {
  type: "open";
  protocol: string;
  extensions: string;
}

export interface SocketMessageEvent {
  type: "message";
  data: string | ArrayBuffer;
}

/** Gateway → socket: `bytes` of what the page sent left the buffer. */
export interface SocketSentEvent {
  type: "sent";
  bytes: number;
}

export interface SocketErrorEvent {
  type: "error";
}

/** Gateway → socket: the connection is closed; the port closes after this. */
export interface SocketCloseEvent {
  type: "close";
  code: number;
  reason: string;
  wasClean: boolean;
}

export type FromGatewaySocketMessage =
  | SocketOpenEvent
  | SocketMessageEvent
  | SocketSentEvent
  | SocketErrorEvent
  | SocketCloseEvent;

/** Socket → gateway: send one message (a string is a text frame). */
export interface SocketSendRequest {
  type: "send";
  data: string | ArrayBuffer;
}

/** Socket → gateway: start the closing handshake (or abort while connecting). */
export interface SocketCloseRequest {
  type: "close";
  code?: number;
  reason?: string;
}

export type ToGatewaySocketMessage = SocketSendRequest | SocketCloseRequest;

/** True when `value` is an object whose `type` is `type`. */
export function isMessageOfType<T extends { type: string }>(
  value: unknown,
  type: T["type"],
): value is T {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === type;
}

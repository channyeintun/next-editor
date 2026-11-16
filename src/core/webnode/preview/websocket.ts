// The gateway's WebSocket client (RFC 6455) for one page socket: the opening
// handshake over a ByteChannel, masked client frames, server frame parsing
// (fragmentation, every length encoding, ping/pong, the closing handshake), and
// the events the page's WebSocket object sees.
import type { ByteChannel } from "../process/runtime";
import { ByteBuffer, ResponseHeadParser, headerValue, headerValues } from "./http1";
import type { ResponseHead } from "./http1";
import type { FromGatewaySocketMessage, ToGatewaySocketMessage } from "./protocol";

const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
/** Largest message (fragments joined) accepted from a server. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const encoder = new TextEncoder();

/** A violation that closes the connection with `code` (1002, 1007, 1009). */
class FrameError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** `Sec-WebSocket-Accept` for `key`: base64(SHA-1(key + GUID)). */
export async function webSocketAccept(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", encoder.encode(key + HANDSHAKE_GUID));
  return base64(new Uint8Array(digest));
}

/** The server port a socket URL reaches, or null when it is not one the runtime serves. */
export function webSocketTargetPort(url: URL, pageHost: string, serverPort: number): number | null {
  if (url.host === pageHost) {
    return serverPort;
  }
  if (LOCAL_HOSTNAMES.has(url.hostname)) {
    if (url.port !== "") {
      return Number(url.port);
    }
    return url.protocol === "wss:" || url.protocol === "https:" ? 443 : 80;
  }
  return null;
}

/** One client frame, masked with a fresh random key. */
export function encodeClientFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const length = payload.length;
  const extended = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const frame = new Uint8Array(2 + extended + 4 + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  frame[1] = 0x80 | (length < 126 ? length : length < 65536 ? 126 : 127);
  const view = new DataView(frame.buffer);
  if (extended === 2) {
    view.setUint16(2, length);
  } else if (extended === 8) {
    view.setUint32(2, Math.floor(length / 2 ** 32));
    view.setUint32(6, length >>> 0);
  }
  const maskAt = 2 + extended;
  const mask = crypto.getRandomValues(new Uint8Array(4));
  frame.set(mask, maskAt);
  for (let i = 0; i < length; i++) {
    frame[maskAt + 4 + i] = payload[i] ^ mask[i & 3];
  }
  return frame;
}

function closePayload(code: number | undefined, reason: string): Uint8Array {
  if (code === undefined) {
    return new Uint8Array(0);
  }
  const text = encoder.encode(reason);
  const payload = new Uint8Array(2 + text.length);
  payload[0] = code >> 8;
  payload[1] = code & 0xff;
  payload.set(text, 2);
  return payload;
}

/** True for a close code a peer may send (RFC 6455 §7.4). */
function isValidReceivedCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** Splits server bytes into frames, whatever the chunk boundaries. */
class FrameReader {
  #buffer = new ByteBuffer();

  /** Feeds bytes and returns every frame now complete. Throws `FrameError`. */
  feed(chunk: Uint8Array): Frame[] {
    this.#buffer.push(chunk);
    const frames: Frame[] = [];
    let offset = 0;
    const buffer = this.#buffer;
    for (;;) {
      const available = buffer.length - offset;
      if (available < 2) {
        break;
      }
      const first = buffer.at(offset);
      const second = buffer.at(offset + 1);
      if (first & 0x70) {
        throw new FrameError(1002, "reserved bits set without a negotiated extension");
      }
      if (second & 0x80) {
        throw new FrameError(1002, "server frames must not be masked");
      }
      let length = second & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (available < 4) {
          break;
        }
        length = (buffer.at(offset + 2) << 8) | buffer.at(offset + 3);
        headerLength = 4;
      } else if (length === 127) {
        if (available < 10) {
          break;
        }
        const high =
          buffer.at(offset + 2) * 2 ** 24 +
          (buffer.at(offset + 3) << 16) +
          (buffer.at(offset + 4) << 8) +
          buffer.at(offset + 5);
        const low =
          buffer.at(offset + 6) * 2 ** 24 +
          (buffer.at(offset + 7) << 16) +
          (buffer.at(offset + 8) << 8) +
          buffer.at(offset + 9);
        if (high >= 2 ** 31) {
          throw new FrameError(1002, "64-bit length with the high bit set");
        }
        length = high * 2 ** 32 + low;
        headerLength = 10;
      }
      if (length > MAX_MESSAGE_BYTES) {
        throw new FrameError(1009, "message too big");
      }
      if (available < headerLength + length) {
        break;
      }
      const start = offset + headerLength;
      frames.push({
        fin: (first & 0x80) !== 0,
        opcode: first & 0x0f,
        payload: buffer.slice(start, start + length),
      });
      offset = start + length;
    }
    if (offset > 0) {
      const rest = buffer.slice(offset);
      buffer.clear();
      buffer.push(rest);
    }
    return frames;
  }
}

/** What a bridge needs to reach the server. */
export interface WebSocketBridgeOptions {
  connect(port: number): Promise<ByteChannel>;
  /** The page socket's port. */
  page: MessagePort;
  url: string;
  protocols: string[];
  pageHost: string;
  serverPort: number;
  /** How long to wait for the server's close frame after sending ours. */
  closeTimeoutMs?: number;
  /** Runs once the page has been told the socket closed. */
  onFinished?: () => void;
}

type BridgeState = "connecting" | "open" | "closing" | "closed";

/** Opens one page WebSocket's connection and relays it until either side closes. */
export function openWebSocketBridge(options: WebSocketBridgeOptions): { dispose(): void } {
  const { page } = options;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5000;
  let state: BridgeState = "connecting";
  let channel: ByteChannel | null = null;
  let closeSent = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const reader = new FrameReader();
  const headParser = new ResponseHeadParser();
  let handshakeDone = false;
  let message: { opcode: number; parts: Uint8Array[]; size: number } | null = null;
  const textDecoder = new TextDecoder("utf-8", { fatal: true });

  function post(event: FromGatewaySocketMessage, transfer: Transferable[] = []): void {
    page.postMessage(event, transfer);
  }

  function release(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (channel) {
      channel.onData = null;
      channel.onEnd = null;
      channel.onClose = null;
      channel.destroy();
      channel = null;
    }
  }

  /** Reports the end to the page and lets go of everything. */
  function finish(code: number, reason: string, wasClean: boolean, error: boolean): void {
    if (state === "closed") {
      return;
    }
    state = "closed";
    if (error) {
      post({ type: "error" });
    }
    post({ type: "close", code, reason, wasClean });
    page.removeEventListener("close", onPageGone);
    page.onmessage = null;
    page.close();
    options.onFinished?.();
  }

  /** Ends the TCP side after our close frame; destroys it if the server never does. */
  function lingerThenRelease(): void {
    const current = channel;
    if (!current) {
      return;
    }
    current.onData = null;
    current.onEnd = release;
    current.onClose = release;
    current.end();
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
    }
    closeTimer = setTimeout(release, closeTimeoutMs);
  }

  function sendFrame(opcode: number, payload: Uint8Array): void {
    channel?.write(encodeClientFrame(opcode, payload));
  }

  function sendClose(code: number | undefined, reason: string): void {
    if (closeSent) {
      return;
    }
    closeSent = true;
    sendFrame(OP_CLOSE, closePayload(code, reason));
  }

  /** Fails the connection (RFC 6455 §7.1.7): close frame with `code`, page sees 1006. */
  function failConnection(code: number | null): void {
    if (state === "closed") {
      return;
    }
    if (code !== null && channel && handshakeDone) {
      sendClose(code, "");
      finish(1006, "", false, true);
      lingerThenRelease();
      return;
    }
    finish(1006, "", false, true);
    release();
  }

  function deliver(opcode: number, parts: Uint8Array[], size: number): void {
    const data = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    if (state !== "open") {
      return; // A message after our close frame is discarded, as a browser does.
    }
    if (opcode === OP_TEXT) {
      let text: string;
      try {
        text = textDecoder.decode(data);
      } catch {
        throw new FrameError(1007, "text message is not valid UTF-8");
      }
      post({ type: "message", data: text });
    } else {
      post({ type: "message", data: data.buffer }, [data.buffer]);
    }
  }

  function onCloseFrame(payload: Uint8Array): void {
    let code = 1005;
    let reason = "";
    if (payload.length === 1) {
      throw new FrameError(1002, "close frame with a one-byte payload");
    }
    if (payload.length >= 2) {
      code = (payload[0] << 8) | payload[1];
      if (!isValidReceivedCloseCode(code)) {
        throw new FrameError(1002, `invalid close code ${code}`);
      }
      try {
        reason = textDecoder.decode(payload.subarray(2));
      } catch {
        throw new FrameError(1007, "close reason is not valid UTF-8");
      }
    }
    // Echo the close (with the same code) unless ours went first.
    sendClose(code === 1005 ? undefined : code, "");
    finish(code, reason, true, false);
    lingerThenRelease();
  }

  function onFrame(frame: Frame): void {
    const { fin, opcode, payload } = frame;
    if (opcode >= OP_CLOSE) {
      if (!fin || payload.length > 125) {
        throw new FrameError(1002, "fragmented or oversized control frame");
      }
      if (opcode === OP_CLOSE) {
        onCloseFrame(payload);
      } else if (opcode === OP_PING) {
        if (!closeSent) {
          sendFrame(OP_PONG, payload);
        }
      } else if (opcode !== OP_PONG) {
        throw new FrameError(1002, `unknown control opcode ${opcode}`);
      }
      return;
    }
    if (opcode === OP_CONTINUATION) {
      if (!message) {
        throw new FrameError(1002, "continuation frame without a message to continue");
      }
    } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (message) {
        throw new FrameError(1002, "new message before the previous one ended");
      }
      message = { opcode, parts: [], size: 0 };
    } else {
      throw new FrameError(1002, `unknown data opcode ${opcode}`);
    }
    message.parts.push(payload);
    message.size += payload.length;
    if (message.size > MAX_MESSAGE_BYTES) {
      throw new FrameError(1009, "message too big");
    }
    if (fin) {
      const done = message;
      message = null;
      deliver(done.opcode, done.parts, done.size);
    }
  }

  function onFrames(chunk: Uint8Array): void {
    for (const frame of reader.feed(chunk)) {
      onFrame(frame);
      if (state === "closed") {
        return;
      }
    }
  }

  function validateHandshake(head: ResponseHead, expectedAccept: string): string | null {
    if (head.status !== 101) {
      return null;
    }
    const upgrade = headerValue(head.headers, "upgrade") ?? "";
    const connection = headerValues(head.headers, "connection")
      .flatMap((value) => value.split(","))
      .map((token) => token.trim().toLowerCase());
    if (upgrade.toLowerCase() !== "websocket" || !connection.includes("upgrade")) {
      return null;
    }
    if (headerValue(head.headers, "sec-websocket-accept") !== expectedAccept) {
      return null;
    }
    if ((headerValue(head.headers, "sec-websocket-extensions") ?? "") !== "") {
      return null; // None were offered.
    }
    const protocol = headerValue(head.headers, "sec-websocket-protocol") ?? "";
    if (protocol !== "" && !options.protocols.includes(protocol)) {
      return null;
    }
    return protocol;
  }

  function onData(chunk: Uint8Array, expectedAccept: string): void {
    if (handshakeDone) {
      onFrames(chunk);
      return;
    }
    const parsed = headParser.feed(chunk);
    if (!parsed) {
      return;
    }
    const protocol = validateHandshake(parsed.head, expectedAccept);
    if (protocol === null) {
      failConnection(null);
      return;
    }
    handshakeDone = true;
    state = "open";
    post({ type: "open", protocol, extensions: "" });
    if (parsed.rest.length > 0) {
      onFrames(parsed.rest);
    }
  }

  function onPageMessage(data: ToGatewaySocketMessage): void {
    if (data.type === "send") {
      if (state !== "open") {
        return;
      }
      const payload =
        typeof data.data === "string" ? encoder.encode(data.data) : new Uint8Array(data.data);
      sendFrame(typeof data.data === "string" ? OP_TEXT : OP_BINARY, payload);
      post({ type: "sent", bytes: payload.length });
      return;
    }
    if (data.type === "close") {
      if (state === "connecting") {
        failConnection(null);
      } else if (state === "open") {
        state = "closing";
        sendClose(data.code, data.reason ?? "");
        if (closeTimer === null) {
          closeTimer = setTimeout(() => {
            finish(1006, "", false, false);
            release();
          }, closeTimeoutMs);
        }
      }
    }
  }

  page.onmessage = (event: MessageEvent<ToGatewaySocketMessage>) => {
    try {
      onPageMessage(event.data);
    } catch {
      failConnection(1011);
    }
  };
  // The page went away without saying so (a crash, or a browser without
  // `pagehide`): where MessagePort reports its peer closing, the server is
  // told the client is going away instead of keeping a dead connection.
  const onPageGone = () => failConnection(1001);
  page.addEventListener("close", onPageGone);

  async function start(): Promise<void> {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      failConnection(null);
      return;
    }
    const port = webSocketTargetPort(url, options.pageHost, options.serverPort);
    if (port === null || port < 1 || port > 65535) {
      failConnection(null);
      return;
    }
    const key = base64(crypto.getRandomValues(new Uint8Array(16)));
    const expectedAccept = await webSocketAccept(key);
    let opened: ByteChannel;
    try {
      opened = await options.connect(port);
    } catch {
      failConnection(null);
      return;
    }
    if (state !== "connecting") {
      opened.destroy();
      return;
    }
    channel = opened;
    opened.onData = (chunk) => {
      if (state === "closed") {
        return;
      }
      try {
        onData(chunk, expectedAccept);
      } catch (error) {
        failConnection(error instanceof FrameError ? error.code : 1002);
      }
    };
    const onEof = () => {
      finish(1006, "", false, state === "connecting");
      release();
    };
    opened.onEnd = onEof;
    opened.onClose = onEof;
    let request =
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
      `Host: localhost:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Origin: http://localhost:${port}\r\n`;
    if (options.protocols.length > 0) {
      request += `Sec-WebSocket-Protocol: ${options.protocols.join(", ")}\r\n`;
    }
    opened.write(encoder.encode(`${request}\r\n`));
  }

  void start();

  return {
    dispose(): void {
      finish(1006, "", false, false);
      release();
    },
  };
}

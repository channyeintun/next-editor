// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { concat, createGatewayHarness, decoder, encoder, latin1, tick } from "./gatewayTestKit";
import type { FromGatewaySocketMessage, ToGatewaySocketMessage } from "./protocol";
import type { LinkedChannel } from "./testChannels";
import { encodeClientFrame, webSocketAccept } from "./websocket";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PAGE_HOST = "k3j2h1-3000.localhost:5173";

let harness: ReturnType<typeof createGatewayHarness>;

afterEach(() => {
  harness?.dispose();
});

interface ClientFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  /** How the length was encoded: 7, 16 or 64 bits. */
  lengthBits: number;
  payload: Uint8Array;
}

/** Encodes an unmasked server frame, optionally forcing a longer length encoding. */
function serverFrame(
  opcode: number,
  payload: Uint8Array | string,
  fin = true,
  mask = false,
): Uint8Array {
  const data = typeof payload === "string" ? encoder.encode(payload) : payload;
  const length = data.length;
  const extended = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const out = new Uint8Array(2 + extended + (mask ? 4 : 0) + length);
  out[0] = (fin ? 0x80 : 0) | opcode;
  out[1] = (mask ? 0x80 : 0) | (length < 126 ? length : length < 65536 ? 126 : 127);
  const view = new DataView(out.buffer);
  if (extended === 2) {
    view.setUint16(2, length);
  } else if (extended === 8) {
    view.setUint32(2, 0);
    view.setUint32(6, length);
  }
  out.set(data, 2 + extended + (mask ? 4 : 0));
  return out;
}

function closeFrame(code: number, reason = ""): Uint8Array {
  const text = encoder.encode(reason);
  const payload = new Uint8Array(2 + text.length);
  payload[0] = code >> 8;
  payload[1] = code & 0xff;
  payload.set(text, 2);
  return serverFrame(0x8, payload);
}

/** A WebSocket server on one channel, written for the test (RFC 6455 server side). */
class FakeWebSocketServer {
  readonly channel: LinkedChannel;
  requestHead = "";
  requestHeaders = new Map<string, string>();
  readonly frames: ClientFrame[] = [];
  #buffer: Uint8Array = new Uint8Array(0);
  #handshaken = false;
  #taken = 0;
  #frameWaiters: (() => void)[] = [];
  #onRequest: (server: FakeWebSocketServer) => void;

  constructor(channel: LinkedChannel, onRequest: (server: FakeWebSocketServer) => void) {
    this.channel = channel;
    this.#onRequest = onRequest;
    channel.onData = (chunk) => this.#onData(chunk);
  }

  /** The correct Sec-WebSocket-Accept for the client's key, computed with Node's own SHA-1. */
  expectedAccept(): string {
    return createHash("sha1")
      .update(`${this.requestHeaders.get("sec-websocket-key")}${GUID}`)
      .digest("base64");
  }

  accept(extraHeaders = "", accept = this.expectedAccept()): void {
    this.channel.write(
      encoder.encode(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extraHeaders}\r\n`,
      ),
    );
  }

  send(frame: Uint8Array): void {
    this.channel.write(frame);
  }

  /** The next frame not yet taken by `nextFrame`. */
  async nextFrame(): Promise<ClientFrame> {
    const index = this.#taken++;
    while (this.frames.length <= index) {
      await new Promise<void>((resolve) => this.#frameWaiters.push(resolve));
    }
    return this.frames[index];
  }

  #onData(chunk: Uint8Array): void {
    this.#buffer = concat([this.#buffer, chunk]);
    if (!this.#handshaken) {
      const text = latin1(this.#buffer);
      const end = text.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      this.#handshaken = true;
      this.requestHead = text.slice(0, end);
      for (const line of this.requestHead.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        this.requestHeaders.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }
      this.#buffer = this.#buffer.slice(end + 4);
      this.#onRequest(this);
    }
    this.#parseFrames();
  }

  #parseFrames(): void {
    for (;;) {
      const bytes = this.#buffer;
      if (bytes.length < 2) {
        return;
      }
      const masked = (bytes[1] & 0x80) !== 0;
      let length = bytes[1] & 0x7f;
      let offset = 2;
      let lengthBits = 7;
      if (length === 126) {
        if (bytes.length < 4) return;
        length = (bytes[2] << 8) | bytes[3];
        offset = 4;
        lengthBits = 16;
      } else if (length === 127) {
        if (bytes.length < 10) return;
        length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(6);
        offset = 10;
        lengthBits = 64;
      }
      const maskLength = masked ? 4 : 0;
      if (bytes.length < offset + maskLength + length) {
        return;
      }
      const mask = bytes.slice(offset, offset + maskLength);
      const payload = bytes.slice(offset + maskLength, offset + maskLength + length);
      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }
      this.frames.push({
        fin: (bytes[0] & 0x80) !== 0,
        opcode: bytes[0] & 0x0f,
        masked,
        lengthBits,
        payload,
      });
      this.#buffer = bytes.slice(offset + maskLength + length);
      const waiters = this.#frameWaiters;
      this.#frameWaiters = [];
      for (const wake of waiters) wake();
    }
  }
}

/** A page-side socket: the port the gateway talks to, and the events it sent. */
function openSocket(url: string, protocols: string[] = []) {
  const channel = new MessageChannel();
  const events: FromGatewaySocketMessage[] = [];
  const waiters: (() => void)[] = [];
  channel.port2.onmessage = (event: MessageEvent<FromGatewaySocketMessage>) => {
    events.push(event.data);
    for (const wake of waiters.splice(0)) wake();
  };
  harness.send({ type: "ws-connect", url, protocols, pageHost: PAGE_HOST, port: channel.port1 }, [
    channel.port1,
  ]);
  return {
    events,
    send(message: ToGatewaySocketMessage, transfer: Transferable[] = []): void {
      channel.port2.postMessage(message, transfer);
    },
    async waitFor(type: FromGatewaySocketMessage["type"]): Promise<FromGatewaySocketMessage> {
      for (;;) {
        const found = events.find((event) => event.type === type);
        if (found) return found;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    close(): void {
      channel.port2.close();
    },
  };
}

/** Serves WebSocket connections on `port`, accepting each with `onRequest`. */
function serveWebSocket(
  port: number,
  onRequest: (server: FakeWebSocketServer) => void,
): Promise<FakeWebSocketServer> {
  return new Promise((resolve) => {
    harness.servers.set(port, (channel) => {
      resolve(new FakeWebSocketServer(channel, onRequest));
    });
  });
}

describe("PreviewGateway WebSocket", () => {
  it("computes Sec-WebSocket-Accept like RFC 6455's example", async () => {
    expect(await webSocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("encodes masked client frames with every length encoding", () => {
    for (const [length, bits] of [
      [5, 7],
      [300, 16],
      [70000, 64],
    ] as const) {
      const frame = encodeClientFrame(0x2, new Uint8Array(length).fill(7));
      expect(frame[0]).toBe(0x82);
      expect(frame[1] & 0x80).toBe(0x80);
      expect(frame[1] & 0x7f).toBe(bits === 7 ? length : bits === 16 ? 126 : 127);
    }
  });

  it("handshakes and relays text and binary both ways with masked client frames", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://k3j2h1-3000.localhost:5173/hmr?token=abc");
    const server = await serverReady;
    expect(await socket.waitFor("open")).toEqual({ type: "open", protocol: "", extensions: "" });

    const lines = server.requestHead.split("\r\n");
    expect(lines[0]).toBe("GET /hmr?token=abc HTTP/1.1");
    expect(server.requestHeaders.get("host")).toBe("localhost:3000");
    expect(server.requestHeaders.get("upgrade")).toBe("websocket");
    expect(server.requestHeaders.get("connection")).toBe("Upgrade");
    expect(server.requestHeaders.get("sec-websocket-version")).toBe("13");
    expect(server.requestHeaders.get("origin")).toBe("http://localhost:3000");
    expect(server.requestHeaders.has("sec-websocket-extensions")).toBe(false);
    expect(server.requestHeaders.has("sec-websocket-protocol")).toBe(false);
    const key = server.requestHeaders.get("sec-websocket-key")!;
    expect(Buffer.from(key, "base64")).toHaveLength(16);

    socket.send({ type: "send", data: "hello server" });
    const text = await server.nextFrame();
    expect(text).toMatchObject({ fin: true, opcode: 0x1, masked: true });
    expect(decoder.decode(text.payload)).toBe("hello server");
    expect(await socket.waitFor("sent")).toEqual({ type: "sent", bytes: 12 });

    const binary = new Uint8Array([0, 1, 2, 255]).buffer;
    socket.send({ type: "send", data: binary }, [binary]);
    const binaryFrame = await server.nextFrame();
    expect(binaryFrame).toMatchObject({ opcode: 0x2, masked: true });
    expect([...binaryFrame.payload]).toEqual([0, 1, 2, 255]);

    server.send(serverFrame(0x1, "hello page"));
    server.send(serverFrame(0x2, new Uint8Array([9, 8, 7])));
    for (let i = 0; i < 20 && socket.events.filter((e) => e.type === "message").length < 2; i++) {
      await tick(2);
    }
    const messages = socket.events.filter((event) => event.type === "message");
    expect(messages[0]).toEqual({ type: "message", data: "hello page" });
    const data = (messages[1] as { data: ArrayBuffer }).data;
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(data)]).toEqual([9, 8, 7]);
    socket.close();
  });

  it("handles 16-bit and 64-bit lengths both ways, split a byte at a time", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://k3j2h1-3000.localhost:5173/");
    const server = await serverReady;
    await socket.waitFor("open");

    const medium = new Uint8Array(300).map((_, i) => i & 0xff);
    const large = new Uint8Array(70000).map((_, i) => (i * 7) & 0xff);
    const mediumFrame = serverFrame(0x2, medium);
    for (let i = 0; i < mediumFrame.length; i++) {
      server.send(mediumFrame.subarray(i, i + 1));
    }
    server.send(serverFrame(0x2, large));
    for (let i = 0; i < 100 && socket.events.filter((e) => e.type === "message").length < 2; i++) {
      await tick(2);
    }
    const [first, second] = socket.events.filter((event) => event.type === "message") as {
      data: ArrayBuffer;
    }[];
    expect(new Uint8Array(first.data)).toEqual(medium);
    expect(new Uint8Array(second.data)).toEqual(large);

    const outgoing = large.slice().buffer;
    socket.send({ type: "send", data: outgoing }, [outgoing]);
    const frame = await server.nextFrame();
    expect(frame.lengthBits).toBe(64);
    expect(frame.payload).toEqual(large);
    socket.send({ type: "send", data: "x".repeat(300) });
    expect((await server.nextFrame()).lengthBits).toBe(16);
    socket.close();
  });

  it("joins fragmented messages and answers pings between fragments", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => {
      server.accept();
      // Frames right behind the 101 head, in the same flush.
      server.send(serverFrame(0x1, "frag", false));
      server.send(serverFrame(0x9, "are you there"));
      server.send(serverFrame(0x0, "men", false));
      server.send(serverFrame(0x0, "ted ✓", true));
    });
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    expect(await socket.waitFor("message")).toEqual({ type: "message", data: "fragmented ✓" });
    const pong = await server.nextFrame();
    expect(pong.opcode).toBe(0xa);
    expect(pong.masked).toBe(true);
    expect(decoder.decode(pong.payload)).toBe("are you there");
    socket.close();
  });

  it("echoes a server close and reports it as clean", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    await socket.waitFor("open");
    server.send(closeFrame(4001, "bye now"));
    expect(await socket.waitFor("close")).toEqual({
      type: "close",
      code: 4001,
      reason: "bye now",
      wasClean: true,
    });
    const echo = await server.nextFrame();
    expect(echo.opcode).toBe(0x8);
    expect((echo.payload[0] << 8) | echo.payload[1]).toBe(4001);
    expect(socket.events.some((event) => event.type === "error")).toBe(false);
  });

  it("sends the page's close and finishes when the server answers", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    await socket.waitFor("open");
    socket.send({ type: "close", code: 3000, reason: "done" });
    const frame = await server.nextFrame();
    expect(frame.opcode).toBe(0x8);
    expect((frame.payload[0] << 8) | frame.payload[1]).toBe(3000);
    expect(decoder.decode(frame.payload.subarray(2))).toBe("done");
    // Messages after our close are dropped.
    server.send(serverFrame(0x1, "late"));
    server.send(closeFrame(3000, "done"));
    expect(await socket.waitFor("close")).toEqual({
      type: "close",
      code: 3000,
      reason: "done",
      wasClean: true,
    });
    expect(socket.events.some((event) => event.type === "message")).toBe(false);
    // Our close was not sent twice.
    await tick(5);
    expect(server.frames.filter((f) => f.opcode === 0x8)).toHaveLength(1);
  });

  it("reports 1005 for a close frame without a code", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    await socket.waitFor("open");
    server.send(serverFrame(0x8, new Uint8Array(0)));
    expect(await socket.waitFor("close")).toMatchObject({ code: 1005, wasClean: true });
  });

  it("negotiates a sub-protocol", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) =>
      server.accept("Sec-WebSocket-Protocol: vite-hmr\r\n"),
    );
    const socket = openSocket("ws://localhost:3000/", ["vite-ping", "vite-hmr"]);
    const server = await serverReady;
    expect(await socket.waitFor("open")).toEqual({
      type: "open",
      protocol: "vite-hmr",
      extensions: "",
    });
    expect(server.requestHeaders.get("sec-websocket-protocol")).toBe("vite-ping, vite-hmr");
    socket.close();
  });

  it("fails a sub-protocol the page did not ask for", async () => {
    harness = createGatewayHarness();
    void serveWebSocket(3000, (server) => server.accept("Sec-WebSocket-Protocol: other\r\n"));
    const socket = openSocket("ws://localhost:3000/", ["vite-hmr"]);
    expect(await socket.waitFor("close")).toEqual({
      type: "close",
      code: 1006,
      reason: "",
      wasClean: false,
    });
    expect(socket.events.map((event) => event.type)).toEqual(["error", "close"]);
  });

  it("fails a bad Sec-WebSocket-Accept with error and close 1006", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) =>
      server.accept("", "bm90IHRoZSByaWdodCBvbmU="),
    );
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    expect(await socket.waitFor("close")).toEqual({
      type: "close",
      code: 1006,
      reason: "",
      wasClean: false,
    });
    expect(socket.events.map((event) => event.type)).toEqual(["error", "close"]);
    await tick(5);
    expect(server.channel.closed).toBe(true);
  });

  it("fails a non-101 answer", async () => {
    harness = createGatewayHarness();
    void serveWebSocket(3000, (server) =>
      server.channel.write(encoder.encode("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")),
    );
    const socket = openSocket("ws://localhost:3000/");
    expect(await socket.waitFor("close")).toMatchObject({ code: 1006, wasClean: false });
  });

  for (const [name, frame] of [
    ["a masked server frame", serverFrame(0x1, "x", true, true)],
    ["reserved bits", new Uint8Array([0xc1, 0x01, 0x78])],
    ["an unknown opcode", serverFrame(0x3, "x")],
    ["a fragmented ping", serverFrame(0x9, "x", false)],
    ["a continuation with nothing to continue", serverFrame(0x0, "x")],
    ["a close code that may not be sent", closeFrame(1005)],
  ] as const) {
    it(`closes with 1002 on ${name}`, async () => {
      harness = createGatewayHarness();
      const serverReady = serveWebSocket(3000, (server) => server.accept());
      const socket = openSocket("ws://localhost:3000/");
      const server = await serverReady;
      await socket.waitFor("open");
      server.send(frame);
      const close = await server.nextFrame();
      expect(close.opcode).toBe(0x8);
      expect((close.payload[0] << 8) | close.payload[1]).toBe(1002);
      expect(await socket.waitFor("close")).toMatchObject({ code: 1006, wasClean: false });
      expect(socket.events.some((event) => event.type === "error")).toBe(true);
    });
  }

  it("closes with 1007 on invalid UTF-8 text", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    await socket.waitFor("open");
    server.send(serverFrame(0x1, new Uint8Array([0xff, 0xfe])));
    const close = await server.nextFrame();
    expect((close.payload[0] << 8) | close.payload[1]).toBe(1007);
    await socket.waitFor("close");
  });

  it("routes localhost:<n> to port n and reports a refused connection", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(4000, (server) => server.accept());
    const socket = openSocket("ws://127.0.0.1:4000/socket");
    const server = await serverReady;
    await socket.waitFor("open");
    expect(server.requestHeaders.get("host")).toBe("localhost:4000");
    socket.close();

    const refused = openSocket("ws://localhost:4999/");
    expect(await refused.waitFor("close")).toMatchObject({ code: 1006, wasClean: false });
    expect(refused.events[0]).toEqual({ type: "error" });
  });

  it("reports 1006 when the server drops the connection", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    await socket.waitFor("open");
    server.channel.destroy();
    expect(await socket.waitFor("close")).toEqual({
      type: "close",
      code: 1006,
      reason: "",
      wasClean: false,
    });
  });

  it("aborts a connecting socket the page closes", async () => {
    harness = createGatewayHarness();
    void serveWebSocket(3000, () => {
      // Never answers the handshake.
    });
    const socket = openSocket("ws://localhost:3000/");
    await tick(5);
    socket.send({ type: "close" });
    expect(await socket.waitFor("close")).toMatchObject({ code: 1006, wasClean: false });
    expect(harness.connections[0].closed).toBe(true);
  });

  it("tells the server the client went away when the page's port closes", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    await socket.waitFor("open");
    socket.close();
    const frame = await server.nextFrame();
    expect(frame.opcode).toBe(0x8);
    expect((frame.payload[0] << 8) | frame.payload[1]).toBe(1001);
  });

  it("keeps a socket open when the control port that brought it closes", async () => {
    harness = createGatewayHarness();
    const serverReady = serveWebSocket(3000, (server) => server.accept());
    const socket = openSocket("ws://localhost:3000/");
    const server = await serverReady;
    await socket.waitFor("open");
    harness.closeControlPort();
    await tick(20);
    server.send(serverFrame(0x1, "still here"));
    await tick(10);
    expect(socket.events).toContainEqual({ type: "message", data: "still here" });
  });
});

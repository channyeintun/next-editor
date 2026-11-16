// @vitest-environment node
// The real `ws` package's WebSocketServer attached to our `http` server through
// its `upgrade` event, driven by a minimal raw WebSocket client over the fake
// runtime's loopback network (masked frames, as a browser sends them).
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime, type ByteChannel } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { Buffer } from "./buffer";
import http from "./http";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

interface WsSocket extends EventEmitter {
  send(data: unknown, options?: { binary?: boolean }): void;
}

interface WsServer extends EventEmitter {
  close(): void;
}

/** The real `ws` package, when node_modules has it (it is not a dependency of ours). */
const ws = ((): { WebSocketServer: new (options: { server: unknown }) => WsServer } | null => {
  try {
    return createRequire(import.meta.url)("ws");
  } catch {
    return null;
  }
})();
const WebSocketServer = ws?.WebSocketServer as NonNullable<typeof ws>["WebSocketServer"];

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function maskedFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const mask = Uint8Array.from([1, 2, 3, 4]);
  const header =
    payload.length < 126
      ? Uint8Array.from([0x80 | opcode, 0x80 | payload.length])
      : Uint8Array.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const frame = new Uint8Array(header.length + 4 + payload.length);
  frame.set(header, 0);
  frame.set(mask, header.length);
  for (let i = 0; i < payload.length; i++) {
    frame[header.length + 4 + i] = payload[i] ^ mask[i % 4];
  }
  return frame;
}

interface Frame {
  opcode: number;
  payload: Buffer;
}

/** A minimal WebSocket client: handshake, then frames in both directions. */
class RawWebSocket {
  #channel: ByteChannel;
  #buffer = Buffer.alloc(0);
  #handshake: string | null = null;
  #frames: Frame[] = [];
  #waiters: (() => void)[] = [];
  closed = false;

  constructor(channel: ByteChannel) {
    this.#channel = channel;
    channel.onData = (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#parse();
      for (const waiter of this.#waiters.splice(0)) {
        waiter();
      }
    };
    channel.onClose = () => {
      this.closed = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter();
      }
    };
  }

  #parse(): void {
    if (this.#handshake === null) {
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      this.#handshake = this.#buffer.subarray(0, end + 4).toString("latin1");
      this.#buffer = this.#buffer.subarray(end + 4);
    }
    while (this.#buffer.length >= 2) {
      const opcode = this.#buffer[0] & 0x0f;
      let length = this.#buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) {
          return;
        }
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      }
      if (this.#buffer.length < offset + length) {
        return;
      }
      this.#frames.push({
        opcode,
        payload: Buffer.from(this.#buffer.subarray(offset, offset + length)),
      });
      this.#buffer = this.#buffer.subarray(offset + length);
    }
  }

  wait<T>(check: () => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const value = check();
        if (value !== undefined) {
          resolve(value);
        } else if (this.closed) {
          reject(new Error("connection closed"));
        } else {
          this.#waiters.push(attempt);
        }
      };
      attempt();
    });
  }

  handshake(): Promise<string> {
    return this.wait(() => this.#handshake ?? undefined);
  }

  nextFrame(): Promise<Frame> {
    return this.wait(() => this.#frames.shift());
  }

  send(opcode: number, payload: string | Uint8Array): void {
    const bytes = typeof payload === "string" ? Buffer.from(payload) : payload;
    this.#channel.write(maskedFrame(opcode, bytes));
  }
}

describe.skipIf(ws === null)("ws on our http server", () => {
  it("completes the handshake and echoes text and binary frames", async () => {
    const server = http.createServer((_req, res) => res.end("plain http"));
    const wss = new WebSocketServer({ server });
    const received: string[] = [];
    wss.on("connection", (socket: WsSocket, req: { url: string }) => {
      received.push(`path ${req.url}`);
      socket.on("message", (data: Uint8Array, isBinary: boolean) => {
        received.push(isBinary ? `binary ${data.length}` : `text ${String(data)}`);
        socket.send(data, { binary: isBinary });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const key = Buffer.from("0123456789abcdef").toString("base64");
    const channel = await fake.net.connect(port, "127.0.0.1");
    const client = new RawWebSocket(channel);
    channel.write(
      Buffer.from(
        `GET /chat HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    const handshake = await client.handshake();
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    expect(handshake).toContain("HTTP/1.1 101 Switching Protocols");
    expect(handshake).toContain(`Sec-WebSocket-Accept: ${accept}`);

    client.send(0x1, "hello ws");
    const text = await client.nextFrame();
    expect(text.opcode).toBe(0x1);
    expect(text.payload.toString()).toBe("hello ws");

    const binary = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    client.send(0x2, binary);
    const echoed = await client.nextFrame();
    expect(echoed.opcode).toBe(0x2);
    expect(Buffer.compare(echoed.payload, Buffer.from(binary))).toBe(0);

    client.send(0x8, Uint8Array.from([0x03, 0xe8]));
    const close = await client.nextFrame();
    expect(close.opcode).toBe(0x8);
    expect(received).toEqual(["path /chat", "text hello ws", "binary 300"]);

    // Plain HTTP still works on the same server.
    const body = await new Promise<string>((resolve) => {
      http.get({ port, agent: false }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += String(chunk)));
        res.on("end", () => resolve(text));
      });
    });
    expect(body).toBe("plain http");
    // An upgraded socket is ws's own, as in Node: closeAllConnections() leaves it.
    for (const peer of (wss as unknown as { clients: Set<{ terminate(): void }> }).clients) {
      peer.terminate();
    }
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("passes the bytes that followed the upgrade request to ws", async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const messages: string[] = [];
    wss.on("connection", (socket: WsSocket) => {
      socket.on("message", (data: Uint8Array) => messages.push(String(data)));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const channel = await fake.net.connect(port, "127.0.0.1");
    const client = new RawWebSocket(channel);
    const key = Buffer.from("fedcba9876543210").toString("base64");
    const request = Buffer.from(
      `GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    // The first frame rides in the same packet as the handshake (`head`).
    channel.write(Buffer.concat([request, maskedFrame(0x1, Buffer.from("early"))]));
    await client.handshake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages).toEqual(["early"]);
    // An upgraded socket is ws's own, as in Node: closeAllConnections() leaves it.
    for (const peer of (wss as unknown as { clients: Set<{ terminate(): void }> }).clients) {
      peer.terminate();
    }
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});

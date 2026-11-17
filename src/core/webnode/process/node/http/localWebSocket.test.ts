// @vitest-environment node
// A process's WebSocket to a local host reaches the server inside the runtime
// (its `upgrade` event), never the browser's own socket.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import { Buffer } from "../buffer";
import { createRefedWebSocket } from "../globals";
import http, { type Server } from "../http";
import type { Socket } from "../net";
import { isLocalWebSocketUrl, LocalWebSocket } from "./localWebSocket";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

beforeEach(() => {
  setRuntime(createFakeRuntime());
});

afterEach(() => {
  setRuntime(null);
});

/** Stands in for the browser's WebSocket: records every URL it is asked to dial. */
const dialed: string[] = [];
class NativeWebSocket extends EventTarget {
  constructor(url: string | URL) {
    super();
    dialed.push(String(url));
  }
}
const RefedWebSocket = createRefedWebSocket(NativeWebSocket as unknown as typeof WebSocket);

/** An echo server: answers the handshake, then sends back every text frame it gets. */
function echoServer(upgrades: string[]): Promise<{ server: Server; port: number }> {
  const server = http.createServer();
  server.on("upgrade", (req, socket: Socket) => {
    upgrades.push(`${req.url} ${req.headers["sec-websocket-protocol"] ?? ""}`);
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}${GUID}`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: chat\r\n\r\n`,
    );
    socket.on("data", (chunk: Uint8Array) => {
      const bytes = Buffer.from(chunk);
      const opcode = bytes[0]! & 0x0f;
      const length = bytes[1]! & 0x7f;
      const mask = bytes.subarray(2, 6);
      const payload = Buffer.from(bytes.subarray(6, 6 + length).map((b, i) => b ^ mask[i & 3]!));
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, payload.length, ...payload]));
        return;
      }
      socket.write(Buffer.from([0x81, payload.length, ...payload]));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, port: (server.address() as { port: number }).port })),
  );
}

describe("WebSocket to a local host", () => {
  it("reaches the in-runtime server, exchanges messages and closes cleanly", async () => {
    const upgrades: string[] = [];
    const { server, port } = await echoServer(upgrades);
    const socket = new RefedWebSocket(`ws://localhost:${port}/live?x=1`, ["chat"]);
    expect(socket).toBeInstanceOf(LocalWebSocket);
    expect(socket instanceof RefedWebSocket).toBe(true);
    expect(socket.readyState).toBe(0);
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      socket.onopen = () => {
        events.push(`open ${socket.protocol}`);
        socket.send("hello");
      };
      socket.onmessage = (event) => {
        events.push(`message ${(event as MessageEvent).data}`);
        socket.close(1000, "bye");
      };
      socket.onclose = (event) => {
        const close = event as CloseEvent;
        events.push(`close ${close.code} ${close.reason} ${close.wasClean}`);
        resolve();
      };
    });
    expect(upgrades).toEqual(["/live?x=1 chat"]);
    expect(events).toEqual(["open chat", "message hello", "close 1000 bye true"]);
    expect(socket.readyState).toBe(3);
    expect(dialed).toEqual([]);
    server.close();
  });

  it("fails with error and 1006 when nothing listens, without dialing the browser", async () => {
    const socket = new RefedWebSocket("ws://127.0.0.1:4999/");
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      socket.onerror = () => events.push("error");
      socket.onclose = (event) => {
        events.push(`close ${(event as CloseEvent).code}`);
        resolve();
      };
    });
    expect(events).toEqual(["error", "close 1006"]);
    expect(dialed).toEqual([]);
  });

  it("leaves a remote host to the browser's WebSocket", () => {
    const socket = new RefedWebSocket("wss://example.com/feed");
    expect(socket).toBeInstanceOf(NativeWebSocket);
    expect(dialed).toEqual(["wss://example.com/feed"]);
    dialed.length = 0;
  });

  it("knows which URLs are local", () => {
    expect(isLocalWebSocketUrl("ws://localhost:3000")).toBe(true);
    expect(isLocalWebSocketUrl("http://api.localhost:3000/x")).toBe(true);
    expect(isLocalWebSocketUrl("wss://[::1]:8443")).toBe(true);
    expect(isLocalWebSocketUrl("ws://example.com")).toBe(false);
    expect(() => new LocalWebSocket("ws://localhost:1/#x")).toThrow(/fragment/);
  });
});

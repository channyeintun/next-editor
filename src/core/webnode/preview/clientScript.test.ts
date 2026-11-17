// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createPreviewClientScript } from "./clientScript";
import { tick } from "./gatewayTestKit";

type Posted = { message: Record<string, unknown>; transfer?: Transferable[] };
type ParentPost = Posted & { targetOrigin?: string };

const EDITOR = "https://editor.test";

/** A fake browsing context the client script runs in. */
function createContext(forwardPreviewErrors: boolean | "exceptions-only" = false) {
  const parentPosts: ParentPost[] = [];
  const controllerPosts: Posted[] = [];
  const nativeCalls: unknown[][] = [];
  class NativeWebSocket {
    constructor(...args: unknown[]) {
      nativeCalls.push(args);
    }
  }
  const parent = {
    postMessage(message: Record<string, unknown>, targetOrigin?: string) {
      parentPosts.push({ message, targetOrigin });
    },
  };
  const window = Object.assign(new EventTarget(), {
    parent,
    WebSocket: NativeWebSocket,
  }) as EventTarget & {
    parent: typeof parent;
    WebSocket: new (url: string, protocols?: string | string[]) => FakeSocket;
  };
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: {
      postMessage(message: Record<string, unknown>, transfer?: Transferable[]) {
        controllerPosts.push({ message, transfer });
      },
    },
    startMessages: vi.fn<() => void>(),
  });
  const location = {
    href: "http://k3j2h1x9ab-5173.localhost:5173/app/?q=1#top",
    host: "k3j2h1x9ab-5173.localhost:5173",
    pathname: "/app/",
    search: "?q=1",
    hash: "#top",
    reload: vi.fn<() => void>(),
  };
  const consoleErrors: unknown[][] = [];
  const fakeConsole = { error: (...args: unknown[]) => consoleErrors.push(args) };
  const source = createPreviewClientScript({ forwardPreviewErrors, editorOrigin: EDITOR });
  const run = () =>
    new Function("window", "navigator", "location", "console", source)(
      window,
      { serviceWorker },
      location,
      fakeConsole,
    );
  run();
  return {
    window,
    parent,
    serviceWorker,
    location,
    parentPosts,
    controllerPosts,
    nativeCalls,
    NativeWebSocket,
    console: fakeConsole,
    consoleErrors,
    run,
  };
}

interface FakeSocket extends EventTarget {
  readonly readyState: number;
  readonly url: string;
  readonly protocol: string;
  readonly extensions: string;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  readonly CONNECTING: number;
  readonly OPEN: number;
}

/** Dispatches a window `message` event that looks as if `source` at `origin` posted `data`. */
function dispatchMessage(
  target: EventTarget,
  data: unknown,
  source: unknown = null,
  origin = EDITOR,
): void {
  const event = new Event("message");
  Object.defineProperties(event, {
    data: { value: data },
    source: { value: source },
    origin: { value: origin },
    ports: { value: [] },
  });
  target.dispatchEvent(event);
}

/** The gateway end of the socket the client opened. */
function gatewayPort(context: ReturnType<typeof createContext>, index = 0) {
  const post = context.controllerPosts.filter((p) => p.message.type === "webnode:ws")[index];
  const port = post.message.port as MessagePort;
  const received: Record<string, unknown>[] = [];
  port.onmessage = (event) => received.push(event.data);
  return { post, port, received };
}

describe("createPreviewClientScript", () => {
  it("produces source that parses for every option", () => {
    for (const option of [true, false, "exceptions-only"] as const) {
      expect(
        () =>
          new Function(
            createPreviewClientScript({ forwardPreviewErrors: option, editorOrigin: EDITOR }),
          ),
      ).not.toThrow();
    }
  });

  it("runs once per window", () => {
    const context = createContext();
    const installed = context.window.WebSocket;
    context.run();
    expect(context.window.WebSocket).toBe(installed);
    expect(context.serviceWorker.startMessages).toHaveBeenCalledTimes(1);
  });

  it("defers other hosts to the native WebSocket and still passes instanceof", () => {
    const context = createContext();
    const WebSocket = context.window.WebSocket;
    const socket = new WebSocket("wss://example.com/feed", ["a"]);
    expect(socket).toBeInstanceOf(context.NativeWebSocket);
    expect(socket instanceof WebSocket).toBe(true);
    expect(context.nativeCalls).toEqual([["wss://example.com/feed", ["a"]]]);
    expect(context.controllerPosts).toHaveLength(0);
  });

  it("validates the URL and protocols like the browser", () => {
    const { window } = createContext();
    expect(() => new window.WebSocket("ftp://localhost/")).toThrow(/scheme/);
    expect(() => new window.WebSocket("ws://localhost/", ["a", "a"])).toThrow(/duplicated/);
    expect(() => new window.WebSocket("ws://localhost/", "bad protocol")).toThrow(/invalid/);
  });

  it("runs a runtime socket through its whole life", async () => {
    const context = createContext();
    const WebSocket = context.window.WebSocket as unknown as (new (
      url: string,
      protocols?: string | string[],
    ) => FakeSocket) & { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number };
    const socket = new WebSocket("ws://k3j2h1x9ab-5173.localhost:5173/?token=abc", "vite-hmr");
    expect(socket instanceof WebSocket).toBe(true);
    expect(socket).toBeInstanceOf(EventTarget);
    expect([WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED]).toEqual([
      0, 1, 2, 3,
    ]);
    expect(socket.OPEN).toBe(1);
    expect(socket.readyState).toBe(0);
    expect(socket.url).toBe("ws://k3j2h1x9ab-5173.localhost:5173/?token=abc");
    expect(socket.binaryType).toBe("blob");
    expect(() => socket.send("too early")).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );

    const gateway = gatewayPort(context);
    expect(gateway.post.message).toMatchObject({
      type: "webnode:ws",
      url: "ws://k3j2h1x9ab-5173.localhost:5173/?token=abc",
      protocols: ["vite-hmr"],
    });
    expect(gateway.post.transfer).toEqual([gateway.port]);

    const seen: string[] = [];
    socket.onopen = () => seen.push(`onopen:${socket.readyState}`);
    socket.addEventListener("open", () => seen.push("listener"));
    gateway.port.postMessage({ type: "open", protocol: "vite-hmr", extensions: "" });
    await tick(5);
    expect(seen).toEqual(["onopen:1", "listener"]);
    expect(socket.protocol).toBe("vite-hmr");

    const messages: MessageEvent[] = [];
    socket.onmessage = (event) => messages.push(event);
    gateway.port.postMessage({ type: "message", data: "hi" });
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    gateway.port.postMessage({ type: "message", data: bytes }, [bytes]);
    await tick(5);
    expect(messages[0]).toBeInstanceOf(MessageEvent);
    expect(messages[0].data).toBe("hi");
    expect(messages[0].origin).toBe("ws://k3j2h1x9ab-5173.localhost:5173");
    expect(messages[1].data).toBeInstanceOf(Blob);
    socket.binaryType = "arraybuffer";
    socket.binaryType = "nonsense";
    expect(socket.binaryType).toBe("arraybuffer");
    const more = new Uint8Array([4]).buffer;
    gateway.port.postMessage({ type: "message", data: more }, [more]);
    await tick(5);
    expect(messages[2].data).toBeInstanceOf(ArrayBuffer);

    socket.send("héllo");
    socket.send(new Uint16Array([1, 2]));
    socket.send(new Blob(["blob!"]));
    socket.send("after blob");
    expect(socket.bufferedAmount).toBe(6 + 4 + 5 + 10);
    for (let i = 0; i < 20 && gateway.received.length < 4; i++) {
      await tick(5);
    }
    expect(
      gateway.received.map((m) =>
        typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer).length,
      ),
    ).toEqual(["héllo", 4, 5, "after blob"]);
    gateway.port.postMessage({ type: "sent", bytes: 6 });
    await tick(5);
    expect(socket.bufferedAmount).toBe(19);

    expect(() => socket.close(999)).toThrow(
      expect.objectContaining({ name: "InvalidAccessError" }),
    );
    expect(() => socket.close(1000, "x".repeat(124))).toThrow(
      expect.objectContaining({ name: "SyntaxError" }),
    );
    socket.close(4000, "bye");
    expect(socket.readyState).toBe(2);
    await tick(5);
    expect(gateway.received.at(-1)).toEqual({ type: "close", code: 4000, reason: "bye" });

    const closes: Event[] = [];
    socket.onclose = (event) => closes.push(event);
    gateway.port.postMessage({ type: "close", code: 4000, reason: "bye", wasClean: true });
    await tick(5);
    expect(socket.readyState).toBe(3);
    expect(closes[0]).toMatchObject({ type: "close", code: 4000, reason: "bye", wasClean: true });
  });

  it("treats localhost and loopback addresses as the runtime", () => {
    const context = createContext();
    for (const url of [
      "ws://localhost:3000/",
      "ws://127.0.0.1:1/",
      "ws://0.0.0.0:2/",
      "ws://[::1]:3/",
      "http://localhost/x",
    ]) {
      new context.window.WebSocket(url);
    }
    expect(context.nativeCalls).toHaveLength(0);
    expect(context.controllerPosts.map((p) => p.message.url)).toEqual([
      "ws://localhost:3000/",
      "ws://127.0.0.1:1/",
      "ws://0.0.0.0:2/",
      "ws://[::1]:3/",
      "ws://localhost/x",
    ]);
  });

  it("hands the service worker a fresh port when it asks for one", () => {
    const context = createContext();
    dispatchMessage(context.serviceWorker, { type: "webnode:need-port" });
    expect(context.parentPosts).toEqual([
      { message: { type: "webnode:preview-connect" }, targetOrigin: EDITOR },
    ]);
    const { port1 } = new MessageChannel();
    // From anyone but the parent: ignored.
    dispatchMessage(context.window, { type: "webnode:preview-port", port: port1 }, {});
    expect(context.controllerPosts).toHaveLength(0);
    // From the parent, but at another origin (a page framing the preview): ignored.
    dispatchMessage(
      context.window,
      { type: "webnode:preview-port", port: port1 },
      context.parent,
      "https://evil.test",
    );
    expect(context.controllerPosts).toHaveLength(0);
    dispatchMessage(context.window, { type: "webnode:preview-port", port: port1 }, context.parent);
    expect(context.controllerPosts).toEqual([
      { message: { type: "webnode:attach", control: port1 }, transfer: [port1] },
    ]);
    port1.close();
  });

  it("closes its open sockets with 1001 when the page is hidden for good", async () => {
    const context = createContext();
    const open = new context.window.WebSocket("ws://k3j2h1x9ab-5173.localhost:5173/a");
    const first = gatewayPort(context, 0);
    first.port.postMessage({ type: "open", protocol: "", extensions: "" });
    const closed = new context.window.WebSocket("ws://k3j2h1x9ab-5173.localhost:5173/b");
    const second = gatewayPort(context, 1);
    second.port.postMessage({ type: "close", code: 1000, reason: "", wasClean: true });
    await tick(5);
    expect(open.readyState).toBe(1);
    expect(closed.readyState).toBe(3);
    context.window.dispatchEvent(new Event("pagehide"));
    await tick(5);
    expect(first.received).toEqual([{ type: "close", code: 1001, reason: "" }]);
    expect(second.received).toEqual([]);
    first.port.close();
  });

  it("reloads when the parent asks", () => {
    const context = createContext();
    dispatchMessage(context.window, { type: "webnode:reload" }, {});
    dispatchMessage(
      context.window,
      { type: "webnode:reload" },
      context.parent,
      "https://evil.test",
    );
    expect(context.location.reload).not.toHaveBeenCalled();
    dispatchMessage(context.window, { type: "webnode:reload" }, context.parent);
    expect(context.location.reload).toHaveBeenCalledTimes(1);
  });

  it("forwards errors, rejections and console.error", () => {
    const context = createContext(true);
    const error = new Error("boom");
    const errorEvent = new Event("error");
    Object.defineProperties(errorEvent, {
      error: { value: error },
      message: { value: "Uncaught Error: boom" },
    });
    context.window.dispatchEvent(errorEvent);
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: "nope" });
    context.window.dispatchEvent(rejection);
    context.console.error("failed", { a: 1 }, () => 1, "x".repeat(20000), new Error("inner"));

    expect(context.parentPosts.every((post) => post.targetOrigin === EDITOR)).toBe(true);
    const payloads = context.parentPosts.map((p) => p.message.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({
      type: "PREVIEW_UNCAUGHT_EXCEPTION",
      message: "Uncaught Error: boom",
      stack: error.stack,
      pathname: "/app/",
      search: "?q=1",
      hash: "#top",
    });
    expect(payloads[1]).toMatchObject({ type: "PREVIEW_UNHANDLED_REJECTION", message: "nope" });
    const consoleError = payloads[2];
    expect(consoleError.type).toBe("PREVIEW_CONSOLE_ERROR");
    const args = consoleError.args as unknown[];
    expect(args[0]).toBe("failed");
    expect(args[1]).toEqual({ a: 1 });
    expect(typeof args[2]).toBe("string");
    expect((args[3] as string).length).toBeLessThan(10010);
    expect(args[4]).toMatchObject({ name: "Error", message: "inner" });
    expect(typeof consoleError.stack).toBe("string");
    for (const payload of payloads) {
      expect(() => structuredClone(payload)).not.toThrow();
    }
    expect(context.consoleErrors).toHaveLength(1);
  });

  it("leaves console.error alone for exceptions-only, and forwards nothing when off", () => {
    const exceptionsOnly = createContext("exceptions-only");
    exceptionsOnly.console.error("x");
    expect(exceptionsOnly.parentPosts).toHaveLength(0);
    exceptionsOnly.window.dispatchEvent(new Event("unhandledrejection"));
    expect(exceptionsOnly.parentPosts).toHaveLength(1);

    const off = createContext(false);
    off.console.error("x");
    off.window.dispatchEvent(new Event("error"));
    expect(off.parentPosts).toHaveLength(0);
  });
});

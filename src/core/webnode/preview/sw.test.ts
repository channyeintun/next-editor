// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemError } from "../errors";
import { PREVIEW_CONNECT_HTML } from "./connectPage";
import { PreviewGateway } from "./gateway";
import { decoder, latin1, readRequest, tick, writeAll } from "./gatewayTestKit";
import { installPreviewServiceWorker } from "./sw";
import type { PreviewServiceWorkerScope, PreviewServiceWorkerTimings } from "./sw";
import { createChannelPair } from "./testChannels";
import type { LinkedChannel } from "./testChannels";

const ORIGIN = "http://k3j2h1x9ab-3000.localhost:5173";

type Listener = (event: never) => void;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A Cache Storage that lives as long as the test: what a restarted worker finds again. */
function createCaches() {
  const stores = new Map<string, Map<string, string>>();
  return {
    async open(name: string) {
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return {
        async match(key: string) {
          const text = store.get(key);
          return text === undefined ? undefined : new Response(text);
        },
        async put(key: string, response: Response) {
          store.set(key, await response.text());
        },
      };
    },
  };
}

/**
 * A window the worker can ask for a port; what it is asked goes to `posts`.
 * With `onAsk` it is a preview with the injected client: it acknowledges the
 * ask, then runs `onAsk` (attaching a port, or not). Without, it is a document
 * that has no client (JSON, an image), which never answers.
 */
function fakeWindow(id: string, posts: unknown[], onAsk?: () => void) {
  return {
    id,
    postMessage(message: unknown) {
      const { ack, ...rest } = message as { ack?: MessagePort };
      posts.push(rest);
      if (onAsk) {
        ack?.postMessage(true);
        onAsk();
      }
    },
  };
}

function createWorker(
  timings: Partial<PreviewServiceWorkerTimings> = {},
  caches?: ReturnType<typeof createCaches>,
) {
  const listeners = new Map<string, Listener>();
  const clientPosts: unknown[] = [];
  const clients = new Map<string, ReturnType<typeof fakeWindow>>();
  const scope = {
    location: { origin: ORIGIN, host: new URL(ORIGIN).host, hostname: new URL(ORIGIN).hostname },
    clients: {
      get: async (id: string) => clients.get(id),
      matchAll: async () => [...clients.values()],
      claim: vi.fn<() => Promise<void>>(async () => {}),
    },
    skipWaiting: vi.fn<() => Promise<void>>(async () => {}),
    caches,
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
  };
  installPreviewServiceWorker(scope as unknown as PreviewServiceWorkerScope, {
    idleMs: 10_000,
    pingTimeoutMs: 50,
    attachTimeoutMs: 50,
    ackTimeoutMs: 50,
    ...timings,
  });

  const servers = new Map<number, (channel: LinkedChannel) => void>();
  const serverChannels: LinkedChannel[] = [];
  const gateway = new PreviewGateway({
    connect: async (port) => {
      const serve = servers.get(port);
      if (!serve) throw createSystemError("ECONNREFUSED", "connect");
      const [client, server] = createChannelPair();
      serverChannels.push(server);
      serve(server);
      return client;
    },
    previewScript: () => "",
    coep: "require-corp",
    forwardPreviewErrors: false,
    editorOrigin: "https://editor.test",
  });
  cleanups.push(() => gateway.dispose());

  function dispatch(type: string, event: object): void {
    (listeners.get(type) as (event: object) => void)(event);
  }

  return {
    scope,
    gateway,
    servers,
    serverChannels,
    clientPosts,
    /** Adds a window this worker controls (see `fakeWindow`). */
    addClient(id: string, onAsk?: () => void) {
      clients.set(id, fakeWindow(id, clientPosts, onAsk));
    },
    lifecycle(type: "install" | "activate"): Promise<unknown> {
      let waited: Promise<unknown> = Promise.resolve();
      dispatch(type, { waitUntil: (promise: Promise<unknown>) => (waited = promise) });
      return waited;
    },
    /** Attaches a raw control port with nothing behind it; returns the far end. */
    attachRaw(): MessagePort {
      const control = new MessageChannel();
      dispatch("message", {
        data: { type: "webnode:attach", control: control.port2 },
        ports: [],
        source: null,
        waitUntil() {},
      });
      cleanups.push(() => control.port1.close());
      return control.port1;
    },
    /** Attaches a fresh gateway control port; resolves when the worker says attached. */
    attach(): Promise<void> {
      const control = new MessageChannel();
      gateway.attach(control.port1, 3000);
      const reply = new MessageChannel();
      cleanups.push(() => reply.port1.close());
      const attached = new Promise<void>((resolve) => {
        reply.port1.onmessage = (event) => {
          if (event.data.type === "webnode:attached") resolve();
        };
      });
      dispatch("message", {
        data: { type: "webnode:attach", control: control.port2, reply: reply.port2 },
        ports: [],
        source: null,
        waitUntil() {},
      });
      return attached;
    },
    message(data: unknown, source: unknown = null): Promise<unknown> {
      let waited: Promise<unknown> = Promise.resolve();
      dispatch("message", {
        data,
        ports: [],
        source,
        waitUntil: (p: Promise<unknown>) => (waited = p),
      });
      return waited;
    },
    /** Dispatches a fetch; resolves with the response, or undefined when the worker let it through. */
    fetch(
      request: Request,
      options: { clientId?: string; navigate?: boolean } = {},
    ): Promise<Response | undefined> {
      if (options.navigate) {
        Object.defineProperty(request, "mode", { value: "navigate" });
      }
      let responded: Promise<Response> | Response | undefined;
      dispatch("fetch", {
        request,
        clientId: options.clientId ?? "",
        respondWith: (response: Promise<Response> | Response) => (responded = response),
        waitUntil() {},
      });
      return Promise.resolve(responded);
    },
  };
}

function serveText(
  worker: ReturnType<typeof createWorker>,
  raw: string | ((channel: LinkedChannel) => void),
) {
  const received: Awaited<ReturnType<typeof readRequest>>[] = [];
  worker.servers.set(3000, (channel) => {
    void readRequest(channel).then((request) => {
      received.push(request);
      if (typeof raw === "string") writeAll(channel, [raw]);
      else raw(channel);
    });
  });
  return received;
}

describe("preview service worker", () => {
  it("skips waiting on install and claims clients on activate", async () => {
    const worker = createWorker();
    await worker.lifecycle("install");
    await worker.lifecycle("activate");
    expect(worker.scope.skipWaiting).toHaveBeenCalled();
    expect(worker.scope.clients.claim).toHaveBeenCalled();
  });

  it("lets cross-origin and /__webnode__/ requests through to the network", async () => {
    const worker = createWorker();
    expect(await worker.fetch(new Request("https://cdn.example.com/x.js"))).toBeUndefined();
    expect(await worker.fetch(new Request(`${ORIGIN}/__webnode__/sw.js`))).toBeUndefined();
  });

  it("serves the connect page at once for a navigation without a control port or a window", async () => {
    // A first load, or the editor's page reloaded: there is nobody to ask, so nothing waits.
    const worker = createWorker({ attachTimeoutMs: 60_000, ackTimeoutMs: 60_000 });
    const response = (await worker.fetch(new Request(`${ORIGIN}/`), { navigate: true }))!;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PREVIEW_CONNECT_HTML);
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(worker.clientPosts).toEqual([]);
  });

  it("serves a reload from a restarted worker without the connect page", async () => {
    const worker = createWorker({ attachTimeoutMs: 2_000 });
    serveText(
      worker,
      "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\n<p>hi",
    );
    // The document being reloaded: its injected client attaches a fresh port.
    worker.addClient("page", () => void worker.attach());
    const response = (await worker.fetch(new Request(`${ORIGIN}/`), { navigate: true }))!;
    expect(worker.clientPosts).toEqual([{ type: "webnode:need-port" }]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<p>hi");
  });

  it("serves the connect page for a navigation when no window attaches in time", async () => {
    const worker = createWorker();
    // Acknowledges the ask, but no port comes.
    worker.addClient("page", () => {});
    const response = (await worker.fetch(new Request(`${ORIGIN}/`), { navigate: true }))!;
    expect(worker.clientPosts).toEqual([{ type: "webnode:need-port" }]);
    expect(await response.text()).toBe(PREVIEW_CONNECT_HTML);
  });

  it("does not wait for a port from a window without the injected client", async () => {
    // A JSON document, say: it can never ask the editor, so only the short acknowledgement is waited for.
    const worker = createWorker({ attachTimeoutMs: 60_000, ackTimeoutMs: 30 });
    worker.addClient("json");
    const response = (await worker.fetch(new Request(`${ORIGIN}/`), { navigate: true }))!;
    expect(worker.clientPosts).toEqual([{ type: "webnode:need-port" }]);
    expect(await response.text()).toBe(PREVIEW_CONNECT_HTML);
  });

  it("asks every window it controls for a navigation, and takes the port one of them gets", async () => {
    const worker = createWorker({ attachTimeoutMs: 2_000 });
    serveText(
      worker,
      "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\n<p>hi",
    );
    worker.addClient("json");
    worker.addClient("page", () => void worker.attach());
    const response = (await worker.fetch(new Request(`${ORIGIN}/`), { navigate: true }))!;
    expect(worker.clientPosts).toHaveLength(2);
    expect(await response.text()).toContain("<p>hi");
  });

  it("asks the windows for a fresh port when the old one no longer answers its ping", async () => {
    const worker = createWorker({ idleMs: 0, pingTimeoutMs: 30, attachTimeoutMs: 2_000 });
    worker.attachRaw(); // a port with no gateway behind it any more
    serveText(
      worker,
      "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\n<p>hi",
    );
    worker.addClient("page", () => void worker.attach());
    const response = (await worker.fetch(new Request(`${ORIGIN}/`), { navigate: true }))!;
    expect(worker.clientPosts).toEqual([{ type: "webnode:need-port" }]);
    expect(await response.text()).toContain("<p>hi");
  });

  /** A worker whose cookie jar takes a while to read back, as a restarted one's does. */
  function slowJarWorker() {
    const stored = createCaches();
    return createWorker(
      {},
      {
        async open(name: string) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return stored.open(name);
        },
      },
    );
  }

  it("keeps a replaced port open for a request it was already handed", async () => {
    const worker = slowJarWorker();
    await worker.attach();
    serveText(worker, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const response = worker.fetch(new Request(`${ORIGIN}/x`));
    // A newer port arrives while the request waits for its cookies on the first one.
    await tick(10);
    await worker.attach();
    expect(await (await response)!.text()).toBe("ok");
  });

  it("sends a request on the newer port when one replaces the port it was about to take", async () => {
    const worker = slowJarWorker();
    await worker.attach();
    serveText(worker, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const response = worker.fetch(new Request(`${ORIGIN}/x`));
    await worker.attach();
    expect(await (await response)!.text()).toBe("ok");
  });

  it("answers 503 for a subresource when no window attaches in time", async () => {
    const worker = createWorker();
    worker.addClient("c1");
    const response = (await worker.fetch(new Request(`${ORIGIN}/main.js`), { clientId: "c1" }))!;
    expect(worker.clientPosts).toEqual([{ type: "webnode:need-port" }]);
    expect(response.status).toBe(503);
  });

  it("asks the client for a port and proceeds once it attaches", async () => {
    const worker = createWorker({ idleMs: 10_000, pingTimeoutMs: 50, attachTimeoutMs: 2_000 });
    serveText(
      worker,
      "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 2\r\n\r\n;;",
    );
    worker.addClient("c1", () => void worker.attach());
    const response = (await worker.fetch(new Request(`${ORIGIN}/main.js`), { clientId: "c1" }))!;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(";;");
  });

  it("proxies requests with headers and body, streaming the response", async () => {
    const worker = createWorker();
    await worker.attach();
    let server: LinkedChannel | null = null;
    const received = serveText(worker, (channel) => {
      server = channel;
      writeAll(channel, [
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: a=1\r\nX-Test: ok\r\nTransfer-Encoding: chunked\r\n\r\n",
        "3\r\n[1,\r\n",
      ]);
    });
    const response = (await worker.fetch(
      new Request(`${ORIGIN}/api/items?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-req": "yes" },
        body: JSON.stringify({ a: 1 }),
      }),
    ))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test")).toBe("ok");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const reader = response.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe("[1,");
    writeAll(server!, ["2\r\n2]\r\n0\r\n\r\n"]);
    expect(decoder.decode((await reader.read()).value)).toBe("2]");
    expect((await reader.read()).done).toBe(true);

    const [request] = received;
    expect(request.requestLine).toBe("POST /api/items?x=1 HTTP/1.1");
    expect(request.headers).toContainEqual(["x-req", "yes"]);
    expect(decoder.decode(request.body)).toBe('{"a":1}');
  });

  it("gives null-body statuses a null body", async () => {
    const worker = createWorker();
    await worker.attach();
    serveText(worker, 'HTTP/1.1 304 Not Modified\r\nETag: "1"\r\n\r\n');
    const response = (await worker.fetch(new Request(`${ORIGIN}/a.css`)))!;
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
  });

  it("tells the gateway to drop the connection when the body is cancelled", async () => {
    const worker = createWorker();
    await worker.attach();
    serveText(worker, "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nabc");
    const response = (await worker.fetch(new Request(`${ORIGIN}/big`)))!;
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    for (let i = 0; i < 20 && !worker.serverChannels[0].closed; i++) await tick(2);
    expect(worker.serverChannels[0].closed).toBe(true);
  });

  it("drops a control port whose gateway no longer answers pings", async () => {
    const worker = createWorker({ idleMs: 0, pingTimeoutMs: 30, attachTimeoutMs: 30 });
    await worker.attach();
    serveText(worker, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    // Alive: the ping is answered and the request proceeds.
    expect(await (await worker.fetch(new Request(`${ORIGIN}/x`)))!.text()).toBe("ok");
    worker.gateway.dispose();
    const response = (await worker.fetch(new Request(`${ORIGIN}/`), { navigate: true }))!;
    expect(await response.text()).toBe(PREVIEW_CONNECT_HTML);
  });

  it("forwards a page WebSocket to the gateway, or fails it without a control port", async () => {
    const worker = createWorker();
    const orphan = new MessageChannel();
    const events: unknown[] = [];
    orphan.port2.onmessage = (event) => events.push(event.data);
    cleanups.push(() => orphan.port2.close());
    await worker.message({
      type: "webnode:ws",
      url: `ws://${new URL(ORIGIN).host}/`,
      protocols: [],
      port: orphan.port1,
    });
    await tick(5);
    expect(events).toEqual([
      { type: "error" },
      { type: "close", code: 1006, reason: "", wasClean: false },
    ]);

    await worker.attach();
    const upgrade = new Promise<string>((resolve) => {
      worker.servers.set(3000, (channel) => {
        channel.onData = (chunk) => resolve(latin1(chunk));
      });
    });
    const socket = new MessageChannel();
    cleanups.push(() => socket.port2.close());
    await worker.message({
      type: "webnode:ws",
      url: `ws://${new URL(ORIGIN).host}/hmr`,
      protocols: ["vite-hmr"],
      port: socket.port1,
    });
    const head = await upgrade;
    expect(head.startsWith("GET /hmr HTTP/1.1\r\nHost: localhost:3000\r\n")).toBe(true);
    expect(head).toContain("Sec-WebSocket-Protocol: vite-hmr\r\n");
  });

  it("keeps cookies the server sets and sends them back by path", async () => {
    const worker = createWorker();
    await worker.attach();
    const received = serveText(
      worker,
      "HTTP/1.1 200 OK\r\nSet-Cookie: sid=abc; Path=/; HttpOnly\r\nSet-Cookie: deep=1; Path=/api\r\nSet-Cookie: gone=x; Max-Age=0\r\nContent-Length: 0\r\n\r\n",
    );
    const first = (await worker.fetch(new Request(`${ORIGIN}/login`)))!;
    expect(first.headers.get("set-cookie")).toBeNull();
    await worker.fetch(new Request(`${ORIGIN}/api/items`));
    await worker.fetch(new Request(`${ORIGIN}/other`));
    const cookie = (index: number) =>
      received[index].headers.find(([name]) => name.toLowerCase() === "cookie")?.[1] ?? null;
    expect(cookie(0)).toBeNull();
    expect(cookie(1)).toBe("deep=1; sid=abc");
    expect(cookie(2)).toBe("sid=abc");
  });

  it("deletes a cookie the server expires", async () => {
    const worker = createWorker();
    await worker.attach();
    let reply = "Set-Cookie: sid=abc; Path=/";
    const received = serveText(worker, (channel) => {
      writeAll(channel, [`HTTP/1.1 200 OK\r\n${reply}\r\nContent-Length: 0\r\n\r\n`]);
    });
    await worker.fetch(new Request(`${ORIGIN}/`));
    reply = "Set-Cookie: sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    await worker.fetch(new Request(`${ORIGIN}/`));
    await worker.fetch(new Request(`${ORIGIN}/`));
    const cookies = received.map(
      (request) => request.headers.find(([name]) => name.toLowerCase() === "cookie")?.[1] ?? null,
    );
    expect(cookies).toEqual([null, "sid=abc", null]);
  });

  it("fails a request in flight when the gateway stops answering", async () => {
    const worker = createWorker({ idleMs: 20, pingTimeoutMs: 20, attachTimeoutMs: 20 });
    worker.attachRaw();
    const response = (await worker.fetch(new Request(`${ORIGIN}/slow`)))!;
    expect(response.status).toBe(502);
  });

  it("fails a request in flight at once when the gateway's port closes", async () => {
    const worker = createWorker();
    const far = worker.attachRaw();
    const pending = worker.fetch(new Request(`${ORIGIN}/slow`));
    await tick(5);
    far.close();
    expect((await pending)!.status).toBe(502);
  });

  it("closes a replaced control port once its last request is done", async () => {
    const worker = createWorker();
    const old = worker.attachRaw();
    const requests: { id: number }[] = [];
    old.onmessage = (event) => requests.push(event.data);
    const pending = worker.fetch(new Request(`${ORIGIN}/a`));
    await tick(5);
    let closed = false;
    old.addEventListener("close", () => (closed = true));
    await worker.attach();
    await tick(10);
    expect(closed).toBe(false);
    const { id } = requests[0];
    old.postMessage({ type: "response-head", id, status: 200, statusText: "OK", headers: [] });
    old.postMessage({ type: "response-end", id });
    expect(await (await pending)!.text()).toBe("");
    for (let i = 0; i < 20 && !closed; i++) await tick(5);
    expect(closed).toBe(true);
  });

  it("asks the page for a port when a WebSocket opens without one", async () => {
    const worker = createWorker({ idleMs: 10_000, pingTimeoutMs: 50, attachTimeoutMs: 2_000 });
    const upgrade = new Promise<string>((resolve) => {
      worker.servers.set(3000, (channel) => {
        channel.onData = (chunk) => resolve(latin1(chunk));
      });
    });
    const posts: unknown[] = [];
    const client = fakeWindow("c1", posts, () => void worker.attach());
    const socket = new MessageChannel();
    cleanups.push(() => socket.port2.close());
    await worker.message(
      {
        type: "webnode:ws",
        url: `ws://${new URL(ORIGIN).host}/hmr`,
        protocols: [],
        port: socket.port1,
      },
      client,
    );
    expect(posts).toEqual([{ type: "webnode:need-port" }]);
    expect((await upgrade).startsWith("GET /hmr HTTP/1.1")).toBe(true);
  });

  it("sends Origin and Referer as the browser would for the page's own request", async () => {
    const worker = createWorker();
    await worker.attach();
    const received = serveText(worker, "HTTP/1.1 204 No Content\r\n\r\n");
    const post = new Request(`${ORIGIN}/echo`, { method: "POST", body: "x" });
    Object.defineProperty(post, "referrer", { value: `${ORIGIN}/form?a=1` });
    await worker.fetch(post);
    const get = new Request(`${ORIGIN}/data`);
    Object.defineProperty(get, "referrer", { value: `${ORIGIN}/form?a=1` });
    await worker.fetch(get);
    const value = (index: number, name: string) =>
      received[index].headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
    expect(value(0, "origin")).toBe("http://localhost:3000");
    expect(value(0, "referer")).toBe("http://localhost:3000/form?a=1");
    // A same-origin GET carries no Origin.
    expect(value(1, "origin")).toBeNull();
    expect(value(1, "referer")).toBe("http://localhost:3000/form?a=1");
  });

  it("sends no Referer under a no-referrer policy", async () => {
    const worker = createWorker();
    await worker.attach();
    const received = serveText(worker, "HTTP/1.1 204 No Content\r\n\r\n");
    const request = new Request(`${ORIGIN}/x`, { referrerPolicy: "no-referrer" });
    Object.defineProperty(request, "referrer", { value: `${ORIGIN}/page` });
    await worker.fetch(request);
    expect(received[0].headers.some(([key]) => key.toLowerCase() === "referer")).toBe(false);
  });

  it("keeps its cookies across a restart of the worker", async () => {
    const caches = createCaches();
    const first = createWorker(undefined, caches);
    await first.attach();
    serveText(
      first,
      "HTTP/1.1 200 OK\r\nSet-Cookie: sid=abc; Path=/; HttpOnly\r\nContent-Length: 0\r\n\r\n",
    );
    await first.fetch(new Request(`${ORIGIN}/login`));
    await tick(5);

    const restarted = createWorker(undefined, caches);
    await restarted.attach();
    const received = serveText(restarted, "HTTP/1.1 204 No Content\r\n\r\n");
    await restarted.fetch(new Request(`${ORIGIN}/me`));
    expect(received[0].headers).toContainEqual(["Cookie", "sid=abc"]);
  });

  it("sends the preview's cookies on a WebSocket handshake", async () => {
    const worker = createWorker();
    await worker.attach();
    serveText(
      worker,
      "HTTP/1.1 200 OK\r\nSet-Cookie: sid=abc; Path=/\r\nContent-Length: 0\r\n\r\n",
    );
    await worker.fetch(new Request(`${ORIGIN}/login`));
    const upgrade = new Promise<string>((resolve) => {
      worker.servers.set(3000, (channel) => {
        channel.onData = (chunk) => resolve(latin1(chunk));
      });
    });
    const socket = new MessageChannel();
    cleanups.push(() => socket.port2.close());
    await worker.message({
      type: "webnode:ws",
      url: `ws://${new URL(ORIGIN).host}/ws`,
      protocols: [],
      port: socket.port1,
    });
    expect(await upgrade).toContain("Cookie: sid=abc\r\n");
  });
});

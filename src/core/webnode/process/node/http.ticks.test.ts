// @vitest-environment node
// When `http` runs its callbacks, on a network that delivers as the kernel's
// does (net/testNetwork.ts). Each order below is what real Node v26 prints for
// the same program: a callback logs itself, then queues a tick (">t") and a
// promise job (">p"). Events a stream emits through readable-stream's own
// ticks ('end', 'close', a response's 'finish') are Node's ticks under the
// test runner, so their order is checked in a browser instead
// (test/cases/nexttick-net-http.cjs).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import http, { type IncomingMessage, type Server, type ServerResponse } from "./http";
import net from "./net";
import { deliverInMacrotasks } from "./net/testNetwork";
import { runMacrotask } from "./eventLoop";
import { createProcess } from "./process";

let fake: FakeRuntime;
let proc: ReturnType<typeof createProcess>;
const order: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fake = createFakeRuntime();
  deliverInMacrotasks(fake.net);
  setRuntime(fake);
  proc = createProcess({ loadBuiltin: () => undefined, ipc: null });
  order.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setRuntime(null);
});

function mark(tag: string): void {
  order.push(tag);
  proc.nextTick(() => order.push(`${tag}>t`));
  void Promise.resolve().then(() => order.push(`${tag}>p`));
}

function callerQueues(): void {
  proc.nextTick(() => order.push("caller>t"));
  void Promise.resolve().then(() => order.push("caller>p"));
}

/** Runs `body` as a macrotask in a task of its own, as a timer's callback is. */
function task(body: () => void, ms = 1): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      runMacrotask(body);
      resolve();
    }, ms);
  });
}

/** Waits until `done()` holds, at most a second. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(done()).toBe(true);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** An http server on 127.0.0.1 and its port. */
async function serve(handler: Handler, options = {}): Promise<{ server: Server; port: number }> {
  const server = http.createServer(options, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, port: (server.address() as { port: number }).port };
}

function shut(server: Server): void {
  server.closeAllConnections();
  server.close();
}

describe("when a request's and a response's events come", () => {
  it("hands a request its socket in the next tick", async () => {
    const { server, port } = await serve((_req, res) => res.end("x"));
    let closed = false;
    await task(() => {
      const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
      request.on("socket", () => mark("socket"));
      request.on("close", () => {
        closed = true;
      });
      callerQueues();
    });
    await until(() => closed);
    expect(order).toEqual(["socket", "caller>t", "socket>t", "caller>p", "socket>p"]);
    shut(server);
  });

  it("runs the request handler and the response callback as macrotasks", async () => {
    const { server, port } = await serve((_req, res) => {
      mark("s:request");
      res.end("x");
    });
    let closed = false;
    const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => {
      mark("c:response");
      res.resume();
    });
    request.on("close", () => {
      closed = true;
    });
    await until(() => closed);
    expect(order).toEqual([
      "s:request",
      "s:request>t",
      "s:request>p",
      "c:response",
      "c:response>t",
      "c:response>p",
    ]);
    shut(server);
  });

  it("emits 'finish' from a tick when end() finds the head and body already sent", async () => {
    let response: ServerResponse | undefined;
    const { server, port } = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": "1" });
      res.write("x");
      response = res;
    });
    const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
    request.on("error", () => {});
    await until(() => response !== undefined);
    await task(() => {
      response?.on("finish", () => mark("finish"));
      response?.end();
      callerQueues();
    }, 10);
    await until(() => order.length === 5);
    expect(order).toEqual(["finish", "caller>t", "finish>t", "caller>p", "finish>p"]);
    shut(server);
  });

  it("corks the socket under a write for one tick", async () => {
    const { server, port } = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": "2" });
      res.write("a");
      order.push(`corked ${res.socket?.writableCorked}`);
      proc.nextTick(() => {
        order.push(`a tick later: corked ${res.socket?.writableCorked}`);
        res.end("b");
      });
    });
    let closed = false;
    const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
    request.on("close", () => {
      closed = true;
    });
    await until(() => closed);
    expect(order).toEqual(["corked 1", "a tick later: corked 0"]);
    shut(server);
  });

  it("reports a write after end() from a tick, callback first", async () => {
    const { server, port } = await serve((_req, res) => {
      res.on("error", (error: Error & { code?: string }) => mark(`error ${error.code}`));
      res.end("x");
      const taken = res.write("late", (error?: (Error & { code?: string }) | null) =>
        mark(`callback ${error?.code}`),
      );
      order.push(`write returned ${taken}`);
      callerQueues();
    });
    let closed = false;
    const request = http.get({ port, host: "127.0.0.1", agent: false }, (res) => res.resume());
    request.on("close", () => {
      closed = true;
    });
    await until(() => closed);
    const code = "ERR_STREAM_WRITE_AFTER_END";
    expect(order).toEqual([
      "write returned false",
      `callback ${code}`,
      `error ${code}`,
      "caller>t",
      `callback ${code}>t`,
      `error ${code}>t`,
      "caller>p",
      `callback ${code}>p`,
      `error ${code}>p`,
    ]);
    shut(server);
  });
});

describe("when http's timers fire", () => {
  it("emits a server's 'timeout' as a macrotask", async () => {
    const { server, port } = await serve(() => {});
    server.setTimeout(20, (socket) => {
      mark("server timeout");
      socket.destroy();
    });
    const request = http.get({ port, host: "127.0.0.1", agent: false });
    request.on("error", () => {});
    await until(() => order.includes("server timeout>p"));
    expect(order).toEqual(["server timeout", "server timeout>t", "server timeout>p"]);
    shut(server);
  });

  it("reports a request whose head is late ('clientError') as a macrotask", async () => {
    const { server, port } = await serve(() => order.push("request"), {
      headersTimeout: 30,
      requestTimeout: 0,
      connectionsCheckingInterval: 10,
    });
    server.on("clientError", (error: Error & { code?: string }, socket) => {
      mark(`clientError ${error.code}`);
      socket.destroy();
    });
    const client = net.connect(port, "127.0.0.1", () =>
      client.write("GET / HTTP/1.1\r\nHost: x\r\n"),
    );
    client.on("error", () => {});
    await until(() => order.length === 3);
    const event = "clientError ERR_HTTP_REQUEST_TIMEOUT";
    expect(order).toEqual([event, `${event}>t`, `${event}>p`]);
    client.destroy();
    shut(server);
  });

  it("emits a request's 'timeout' as a macrotask", async () => {
    const { server, port } = await serve(() => {});
    const request = http.get({ port, host: "127.0.0.1", agent: false });
    request.on("error", () => {});
    request.setTimeout(20, () => mark("request timeout"));
    await until(() => order.includes("request timeout>p"));
    expect(order).toEqual(["request timeout", "request timeout>t", "request timeout>p"]);
    request.destroy();
    shut(server);
  });
});

describe("when a request to another host is answered through fetch", () => {
  function stubFetch(respond: () => Response): void {
    globalThis.fetch = (() => Promise.resolve(respond())) as typeof fetch;
  }

  /**
   * A response body that hands out `chunks` one read at a time, each a few
   * milliseconds after it is asked for, as a network does: by then the
   * response is flowing, so a chunk pushed into it is emitted at once.
   */
  function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
    const pending = chunks.map((chunk) => new TextEncoder().encode(chunk));
    return new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 3));
        const next = pending.shift();
        if (next === undefined) {
          controller.close();
        } else {
          controller.enqueue(next);
        }
      },
    });
  }

  it("runs the response callback and each chunk of the body as a macrotask", async () => {
    stubFetch(() => new Response(bodyOf(["one", "two"])));
    let closed = false;
    const request = http.get("http://example.com/", (res) => {
      mark("response");
      res.on("data", (chunk: Uint8Array) => mark(`data ${String(chunk)}`));
    });
    request.on("close", () => {
      closed = true;
    });
    await until(() => closed);
    expect(order).toEqual([
      "response",
      "response>t",
      "response>p",
      "data one",
      "data one>t",
      "data one>p",
      "data two",
      "data two>t",
      "data two>p",
    ]);
    // The event loop holds the process while ticks wait: released once they ran.
    await until(() => fake.refCount === 0);
  });

  it("goes on with the body after a 'data' listener waited for the reader", async () => {
    stubFetch(() => new Response(bodyOf(["a".repeat(70_000), "b", "c"])));
    const sizes: number[] = [];
    let ended = false;
    http.get("http://example.com/", (res) => {
      // Nobody reads at first: the first chunk fills the response.
      setTimeout(() => {
        res.on("data", (chunk: Uint8Array) => sizes.push(chunk.length));
        res.on("end", () => {
          ended = true;
        });
      }, 30);
    });
    await until(() => ended);
    expect(sizes).toEqual([70_000, 1, 1]);
    // The event loop holds the process while ticks wait: released once they ran.
    await until(() => fake.refCount === 0);
  });

  it("fails the response when its body breaks off", async () => {
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("cut"));
            },
          }),
        ),
    );
    const events: string[] = [];
    let closed = false;
    const request = http.get("http://example.com/", (res) => {
      res.on("error", (error: Error & { code?: string }) =>
        events.push(`response error ${error.code}`),
      );
      res.resume();
    });
    request.on("error", (error: Error) => events.push(`request error ${error.message}`));
    request.on("close", () => {
      closed = true;
    });
    await until(() => closed && events.length === 2);
    expect(events.sort()).toEqual(["request error cut", "response error ECONNRESET"]);
    // The event loop holds the process while ticks wait: released once they ran.
    await until(() => fake.refCount === 0);
  });

  it("emits 'continue' from the event loop for Expect: 100-continue", async () => {
    stubFetch(() => new Response("done"));
    let closed = false;
    await task(() => {
      const request = http.request(
        { host: "example.com", method: "POST", headers: { Expect: "100-continue" } },
        (res) => res.resume(),
      );
      request.on("continue", () => {
        mark("continue");
        request.end("body");
      });
      request.on("close", () => {
        closed = true;
      });
      callerQueues();
    });
    await until(() => closed);
    expect(order).toEqual(["caller>t", "caller>p", "continue", "continue>t", "continue>p"]);
  });
});

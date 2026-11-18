// @vitest-environment node
// When `net` runs its callbacks, on a network that delivers as the kernel's
// does (net/testNetwork.ts). Each order below is what real Node v26 prints for
// the same program: a callback logs itself, then queues a tick (">t") and a
// promise job (">p").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import net, { type Server, type Socket } from "./net";
import { deliverInMacrotasks } from "./net/testNetwork";
import { runMacrotask } from "./eventLoop";
import { createProcess } from "./process";

let fake: FakeRuntime;
let proc: ReturnType<typeof createProcess>;
const order: string[] = [];

beforeEach(() => {
  fake = createFakeRuntime();
  deliverInMacrotasks(fake.net);
  setRuntime(fake);
  proc = createProcess({ loadBuiltin: () => undefined, ipc: null });
  order.length = 0;
});

afterEach(() => {
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
function task(body: () => void): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      runMacrotask(body);
      resolve();
    }, 1);
  });
}

/** Waits until `done()` holds, at most a second. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(done()).toBe(true);
}

/** Lets what is queued now, and what that queues, run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A server that keeps its connections open, listening on 127.0.0.1. */
async function echoless(): Promise<{ server: Server; port: number }> {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  await settle();
  order.length = 0;
  return { server, port: (server.address() as { port: number }).port };
}

describe("when a server's events come", () => {
  it("has its handle a tick after listen() on an address, before any promise job", async () => {
    const seen: unknown[] = [];
    await task(() => {
      const byAddress = net.createServer().listen(0, "127.0.0.1");
      const byName = net.createServer().listen(0, "localhost");
      void Promise.resolve().then(() => {
        seen.push(byAddress.listening, byAddress.address()?.address, byName.listening);
      });
    });
    await settle();
    expect(seen).toEqual([true, "127.0.0.1", false]);
  });

  it("emits 'listening' on an address in the second tick", async () => {
    await task(() => {
      const server = net.createServer();
      server.on("listening", () => mark("listening"));
      server.listen(0, "127.0.0.1", () => {
        mark("callback");
        server.close(() => mark("closed"));
      });
      callerQueues();
    });
    await until(() => order.includes("closed>p"));
    expect(order).toEqual([
      "caller>t",
      "listening",
      "callback",
      "listening>t",
      "callback>t",
      "closed",
      "closed>t",
      "caller>p",
      "listening>p",
      "callback>p",
      "closed>p",
    ]);
  });

  it("reports an address in use from ticks", async () => {
    const { server, port } = await echoless();
    await task(() => {
      const second = net.createServer();
      second.on("error", (error: Error & { code?: string; address?: string }) =>
        mark(`error ${error.code} ${error.address}`),
      );
      second.listen(port, "127.0.0.1");
      callerQueues();
    });
    await until(() => order.length === 5);
    expect(order).toEqual([
      "caller>t",
      "error EADDRINUSE 127.0.0.1",
      "error EADDRINUSE 127.0.0.1>t",
      "caller>p",
      "error EADDRINUSE 127.0.0.1>p",
    ]);
    server.close();
  });

  it("listens on a name from the event loop", async () => {
    await task(() => {
      const server = net.createServer();
      server.listen(0, "localhost", () => {
        mark("listening");
        server.close();
      });
      callerQueues();
    });
    await until(() => order.length === 5);
    expect(order).toEqual(["caller>t", "caller>p", "listening", "listening>t", "listening>p"]);
  });

  it("emits 'listening' without a host, and 'close', from a tick", async () => {
    let server: Server | undefined;
    await task(() => {
      server = net.createServer();
      server.listen(0, () => mark("listening"));
      callerQueues();
    });
    await until(() => order.length === 5);
    expect(order).toEqual(["listening", "caller>t", "listening>t", "caller>p", "listening>p"]);
    order.length = 0;
    await task(() => {
      server?.close(() => mark("closed"));
      callerQueues();
    });
    await until(() => order.length === 5);
    expect(order).toEqual(["closed", "caller>t", "closed>t", "caller>p", "closed>p"]);
  });
});

describe("when a socket's events come", () => {
  it("asks for a connection to an address in the next tick", async () => {
    const { server, port } = await echoless();
    const connect = fake.net.connect;
    fake.net.connect = (to, host) => {
      order.push("asked");
      return connect(to, host);
    };
    let client: Socket | undefined;
    await task(() => {
      client = net.connect(port, "127.0.0.1");
      callerQueues();
    });
    await until(() => order.length === 3);
    expect(order).toEqual(["asked", "caller>t", "caller>p"]);
    client?.destroy();
    server.close();
  });

  it("answers a connect to an address as a macrotask", async () => {
    const { server, port } = await echoless();
    let client: Socket | undefined;
    await task(() => {
      client = net.connect(port, "127.0.0.1", () => mark("connect"));
      client.on("ready", () => order.push("ready"));
      callerQueues();
    });
    await until(() => order.includes("connect>p"));
    expect(order).toEqual(["caller>t", "caller>p", "connect", "ready", "connect>t", "connect>p"]);
    client?.destroy();
    server.close();
  });

  it("connects to a name after a lookup, from the event loop", async () => {
    const { server, port } = await echoless();
    let client: Socket | undefined;
    await task(() => {
      client = net.connect({ port, host: "localhost", family: 4 }, () => mark("connect"));
      client.on("lookup", (_error: unknown, address: string, family: number, host: string) =>
        order.push(`lookup ${address} ${family} ${host}`),
      );
      callerQueues();
    });
    await until(() => order.includes("connect>p"));
    expect(order).toEqual([
      "caller>t",
      "caller>p",
      "lookup 127.0.0.1 4 localhost",
      "connect",
      "connect>t",
      "connect>p",
    ]);
    client?.destroy();
    server.close();
  });

  it("emits 'timeout' as a macrotask", async () => {
    const { server, port } = await echoless();
    const client = net.connect(port, "127.0.0.1");
    client.setTimeout(20);
    client.on("timeout", () => {
      mark("timeout");
      client.destroy();
    });
    await until(() => order.includes("timeout>p"));
    expect(order).toEqual(["timeout", "timeout>t", "timeout>p"]);
    server.close();
  });

  // The stream emits 'error' and 'close' through readable-stream's ticks,
  // which under the test runner are Node's own: where they fall among the
  // caller's ticks is checked in a browser (test/cases/nexttick-net-http.cjs).
  it("given an aborted signal, reports the abort and still connects, as Node does", async () => {
    const { server, port } = await echoless();
    const controller = new AbortController();
    controller.abort();
    let client: Socket | undefined;
    await task(() => {
      client = net.connect({ port, host: "127.0.0.1", signal: controller.signal });
      order.push(`destroyed ${client.destroyed}`);
      client.on("error", (error: Error) => order.push(`error ${error.name}`));
      client.on("close", (hadError: unknown) => order.push(`close ${hadError}`));
      client.on("connect", () => order.push("connect"));
    });
    await until(() => order.includes("connect"));
    expect(order).toEqual(["destroyed false", "error AbortError", "close undefined", "connect"]);
    order.length = 0;
    client?.destroy();
    await until(() => order.length === 1);
    expect(order).toEqual(["close false"]);
    server.close();
  });

  it("leaves a socket made with an aborted signal usable, as Node does", async () => {
    const controller = new AbortController();
    controller.abort();
    const socket = new net.Socket({ signal: controller.signal });
    expect(socket.destroyed).toBe(false);
    socket.on("error", (error: Error) => order.push(`error ${error.name}`));
    socket.on("close", (hadError: unknown) => order.push(`close ${hadError}`));
    await until(() => order.length === 2);
    expect(order).toEqual(["error AbortError", "close undefined"]);
    expect(socket.destroyed).toBe(false);
    socket.removeAllListeners("close");
    socket.destroy();
  });

  it("closes the answer to a connect the socket gave up, and keeps the next one's", async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk: Uint8Array) => received.push(String(chunk)));
      socket.on("close", () => received.push("closed"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    let asked = 0;
    const connect = fake.net.connect;
    fake.net.connect = (to, host) => {
      asked += 1;
      if (asked === 1) {
        // The first answer is still on its way.
        queueMicrotask(() => {
          client.destroy();
          client.connect(port, "127.0.0.1");
        });
      }
      return connect(to, host);
    };
    const client = net.connect(port, "127.0.0.1");
    client.on("connect", () => order.push("connect"));
    client.on("error", () => {});
    await until(() => order.length > 0 && received.includes("closed"));
    client.write("to the second");
    await until(() => received.length === 2);
    expect(asked).toBe(2);
    expect(order).toEqual(["connect"]);
    expect(received).toEqual(["closed", "to the second"]);
    client.destroy();
    server.close();
  });

  it("fails a second connect() from a tick while the first is in flight", async () => {
    const { server, port } = await echoless();
    const asked: string[] = [];
    const connect = fake.net.connect;
    fake.net.connect = (to, host) => {
      asked.push(`asked, connecting ${client?.connecting}`);
      return connect(to, host);
    };
    let client: Socket | undefined;
    await task(() => {
      client = net.connect(port, "127.0.0.1");
      order.push(`returns the socket ${client.connect(port, "127.0.0.1") === client}`);
      client.on("connect", () => order.push("connect"));
      client.on("error", (error: Error & { code?: string; syscall?: string }) =>
        order.push(`error ${error.code} ${error.syscall}: ${error.message}`),
      );
      client.on("close", (hadError: unknown) => order.push(`close ${hadError}`));
    });
    await until(() => order.includes("close true"));
    await settle();
    expect(order).toEqual([
      "returns the socket true",
      `error EALREADY connect: connect EALREADY 127.0.0.1:${port}`,
      "close true",
    ]);
    // The kernel was asked once; the answer to that connect is closed, not kept.
    expect(asked).toEqual(["asked, connecting true"]);
    // Only the listening server holds the process once the ticks have run.
    await until(() => fake.refCount === 1);
    server.close();
  });

  // Real Node v26 and v22: by name, each lookup starts its own attempt and
  // the second cancels the first, whose AggregateError of one ECANCELED
  // failure (code ECANCELED, empty message) takes the socket. With
  // autoSelectFamily false both share one handle: EALREADY.
  it("fails a second connect() by name while the first is in flight with ECANCELED", async () => {
    const { server, port } = await echoless();
    const failures: unknown[] = [];
    for (const autoSelectFamily of [undefined, false]) {
      let client: Socket | undefined;
      const events: string[] = [];
      await task(() => {
        client = net.connect({ port, host: "localhost", autoSelectFamily });
        client.connect({ port, host: "localhost", autoSelectFamily });
        client.on("connect", () => events.push("connect"));
        client.on("error", (error: Error) => {
          failures.push(error);
          events.push(`error ${(error as { code?: string }).code}`);
        });
        client.on("close", (hadError: unknown) => events.push(`close ${hadError}`));
      });
      await until(() => events.includes("close true"));
      expect(events).toEqual([
        `error ${autoSelectFamily === false ? "EALREADY" : "ECANCELED"}`,
        "close true",
      ]);
    }
    const canceled = failures[0] as AggregateError & { code?: string };
    expect(canceled).toBeInstanceOf(AggregateError);
    expect([canceled.name, canceled.message, canceled.code, Object.keys(canceled)]).toEqual([
      "AggregateError",
      "",
      "ECANCELED",
      ["code"],
    ]);
    expect(
      canceled.errors.map((error: Error & Record<string, unknown>) => [
        error.message,
        error.code,
        error.syscall,
        error.address,
        error.port,
      ]),
    ).toEqual([[`connect ECANCELED 127.0.0.1:${port}`, "ECANCELED", "connect", "127.0.0.1", port]]);
    expect((failures[1] as Error).message).toBe(`connect EALREADY 127.0.0.1:${port}`);
    await until(() => fake.refCount === 1);
    server.close();
  });

  // Real Node v26 and v22: `net.setDefaultAutoSelectFamily(false)` makes a
  // connect that does not say share the socket's one handle too.
  it("takes autoSelectFamily from net.setDefaultAutoSelectFamily when a connect does not say", async () => {
    const { server, port } = await echoless();
    const events: string[] = [];
    net.setDefaultAutoSelectFamily(false);
    try {
      await task(() => {
        const client = net.connect({ port, host: "localhost" });
        client.connect({ port, host: "localhost" });
        client.on("error", (error: Error) =>
          events.push(`error ${(error as { code?: string }).code}`),
        );
        client.on("close", (hadError: unknown) => events.push(`close ${hadError}`));
      });
      await until(() => events.includes("close true"));
    } finally {
      net.setDefaultAutoSelectFamily(true);
    }
    expect(events).toEqual(["error EALREADY", "close true"]);
    await until(() => fake.refCount === 1);
    server.close();
  });

  it("fails a second connect() on a connected socket with EISCONN, and the writes queued behind it", async () => {
    const { server, port } = await echoless();
    let client: Socket | undefined;
    await task(() => {
      client = net.connect(port, "127.0.0.1", () => {
        client?.connect(port, "127.0.0.1");
        order.push(`connecting ${client?.connecting} pending ${client?.pending}`);
        client?.write("x", (error?: (Error & { code?: string }) | null) =>
          order.push(`write ${error?.code}`),
        );
      });
      client.on("error", (error: Error & { code?: string; errno?: number }) =>
        order.push(`error ${error.code} ${error.errno}: ${error.message}`),
      );
      client.on("close", (hadError: unknown) => order.push(`close ${hadError}`));
    });
    await until(() => order.length === 4);
    // The fake network gives this end no port, so the message names none.
    expect(order.slice(0, 2)).toEqual([
      "connecting true pending true",
      `error EISCONN -106: connect EISCONN 127.0.0.1:${port}`,
    ]);
    expect(order.slice(2).sort()).toEqual([
      "close true",
      "write ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
    ]);
    server.close();
  });
});

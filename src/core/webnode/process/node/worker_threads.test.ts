// @vitest-environment node
// Node's port interface on fake entangled ports: closing one end emits 'close'
// on the other and releases the ref its 'message' listener held.
import { setMaxListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import type { ThreadSpawnRequest } from "../runtime";
import { Buffer } from "./buffer";
import { createBroadcastHub } from "./internal/broadcastHub";
import { createProcess, type NodeProcess } from "./process";
import type { Readable, Writable } from "./stream";
import workerThreads, {
  addNodePortInterface,
  connectProcess,
  isPortCloseMessage,
  listenOnPlatformPort,
  cloneWithPorts,
  processBroadcastChannel,
  refuseClosedPortsToClone,
  THREAD_EXIT_MESSAGE,
  threadErrorMessage,
  Worker,
} from "./worker_threads";

// A port's one listener is followed by the event loop's own (eventLoop.ts
// `addMacrotaskListener`), more than Node expects on an EventTarget.
setMaxListeners(100);

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

/**
 * A MessagePort stand-in: messages reach the peer in a later task, none after
 * close, and wait in the peer until it is started, as a platform port's do.
 */
class FakePort extends EventTarget {
  peer: FakePort | null = null;
  closed = false;
  started = false;
  #handler: ((event: MessageEvent) => void) | null = null;
  #queued: unknown[] = [];

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.#handler;
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    if (this.#handler) {
      this.removeEventListener("message", this.#handler as EventListener);
    }
    this.#handler = handler;
    if (handler) {
      this.addEventListener("message", handler as EventListener);
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const data of this.#queued.splice(0)) {
      this.#receive(data);
    }
  }

  postMessage(data: unknown, transfer?: unknown): void {
    const peer = this.peer;
    if (this.closed || !peer) {
      return;
    }
    data = transferPorts(data, transfer);
    if (peer.started) {
      peer.#receive(data);
    } else {
      peer.#queued.push(data);
    }
  }

  #receive(data: unknown): void {
    setImmediate(() => {
      if (!this.closed) {
        // As the platform delivers a message: not through the port's own dispatchEvent.
        EventTarget.prototype.dispatchEvent.call(this, new MessageEvent("message", { data }));
      }
    });
  }

  close(): void {
    this.closed = true;
  }

  /** The port that takes this one's place where it is transferred to: the peer's messages go there now. */
  moved(): FakePort {
    const moved = new FakePort();
    moved.peer = this.peer;
    if (this.peer) {
      this.peer.peer = moved;
    }
    moved.#queued = this.#queued.splice(0);
    this.peer = null;
    this.closed = true;
    return moved;
  }
}
addNodePortInterface(FakePort.prototype);

/**
 * `data` as it arrives when it is posted with `transfer` (a list, or options
 * with one): each FakePort the list names is replaced by the port that takes
 * its place, as the platform moves a port.
 */
function transferPorts(data: unknown, transfer: unknown): unknown {
  const list = Array.isArray(transfer)
    ? transfer
    : ((transfer as { transfer?: unknown[] } | undefined)?.transfer ?? []);
  const moved = new Map<unknown, FakePort>();
  for (const item of list) {
    if (item instanceof FakePort) {
      moved.set(item, item.moved());
    }
  }
  const copy = (value: unknown): unknown => {
    if (moved.has(value)) {
      return moved.get(value);
    }
    if (Array.isArray(value)) {
      return value.map(copy);
    }
    if (value !== null && typeof value === "object" && !(value instanceof EventTarget)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)]));
    }
    return value;
  };
  return moved.size === 0 ? data : copy(data);
}

type NodePort = FakePort & {
  on(event: string, listener: (...args: unknown[]) => void): NodePort;
  once(event: string, listener: (...args: unknown[]) => void): NodePort;
  off(event: string, listener: (...args: unknown[]) => void): NodePort;
  close(): void;
  ref(): void;
  unref(): void;
};

function channel(): [NodePort, NodePort] {
  const a = new FakePort();
  const b = new FakePort();
  a.peer = b;
  b.peer = a;
  return [a as NodePort, b as NodePort];
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
/** Lets the event loop turn until `done()` holds, for a second at most. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
/**
 * Lets the macrotasks the ports queue themselves ('close', held messages) run:
 * a while, and then many turns of the event loop, each of which delivers what
 * was posted before it however long the machine took to get there.
 */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (let index = 0; index < 50; index += 1) {
    await turn();
  }
};
/** A message as the platform delivers it: not through the port's own dispatchEvent. */
const deliver = (port: EventTarget, data: unknown) =>
  EventTarget.prototype.dispatchEvent.call(port, new MessageEvent("message", { data }));
/**
 * A message as a browser dispatches it: the event stays at its target until
 * every listener has run (Node's EventTarget says NONE from the second on).
 */
const deliverAsBrowser = (port: EventTarget, data: unknown) => {
  const event = new MessageEvent("message", { data });
  let dispatching = true;
  Object.defineProperty(event, "eventPhase", {
    get: () => (dispatching ? Event.AT_TARGET : Event.NONE),
  });
  try {
    EventTarget.prototype.dispatchEvent.call(port, event);
  } finally {
    dispatching = false;
  }
};
/** Delivers `values` to `port` as the platform does, each in a task of its own. */
const deliverEachAsBrowser = (port: EventTarget, values: unknown[]) => {
  for (const value of values) setImmediate(() => deliverAsBrowser(port, value));
};

describe("MessagePort close", () => {
  it("closing one end emits 'close' on the other and drops its ref", async () => {
    const [port1, port2] = channel();
    const messages: unknown[] = [];
    let closes = 0;
    port2.on("message", (value) => messages.push(value));
    port2.on("close", () => {
      closes += 1;
    });
    expect(fake.refCount).toBe(1);
    port1.postMessage("hello");
    port1.close();
    await settle();
    expect(messages).toEqual(["hello"]);
    expect(closes).toBe(1);
    expect(fake.refCount).toBe(0);
    expect(port2.closed).toBe(true);
  });

  it("emits 'close' once on the end that closes, from the event loop, and waits for it", async () => {
    const [port1] = channel();
    let closes = 0;
    port1.on("message", () => {});
    port1.on("close", () => {
      closes += 1;
    });
    expect(fake.refCount).toBe(1);
    port1.close();
    port1.close();
    // As in Node: the caller goes on first, and the process stays for the event.
    expect(closes).toBe(0);
    expect(fake.refCount).toBe(1);
    await settle();
    expect(closes).toBe(1);
    expect(fake.refCount).toBe(0);
  });

  it("gives 'close' to listeners of both kinds in the order they were added, one added after close() too", async () => {
    const [port1, port2] = channel();
    const seen: string[] = [];
    const describe = (event: Event, port: FakePort) =>
      [event.type, event.target === port, event instanceof Event].join(" ");
    port1.addEventListener("close", (event) => seen.push(`1 event ${describe(event, port1)}`));
    port1.on("close", (...args: unknown[]) =>
      seen.push(`1 node ${args.length} ${describe(args[0] as Event, port1)}`),
    );
    port2.on("close", () => seen.push("2 node"));
    port2.addEventListener("close", (event) => seen.push(`2 event ${describe(event, port2)}`));
    port2.on("message", () => {});
    port1.close();
    port1.once("close", () => seen.push("1 added after close()"));
    await settle();
    expect(seen.filter((line) => line.startsWith("1"))).toEqual([
      "1 event close true true",
      "1 node 1 close true true",
      "1 added after close()",
    ]);
    expect(seen.filter((line) => line.startsWith("2"))).toEqual([
      "2 node",
      "2 event close true true",
    ]);
  });

  it("emits the 'close' of ports closed together in order, each one's ticks before the next", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [first] = channel();
    const [second] = channel();
    const order: string[] = [];
    first.on("close", () => {
      order.push("first");
      process.nextTick(() => order.push("first's tick"));
    });
    second.on("close", () => order.push("second"));
    first.close();
    second.close();
    await settle();
    expect(order).toEqual(["first", "first's tick", "second"]);
  });

  it("keeps the platform's own close event from the program, which gets the port's once", async () => {
    const [, port2] = channel();
    let closes = 0;
    port2.addEventListener("close", () => {
      closes += 1;
    });
    // Where the platform has the event: the other end's thread went away.
    EventTarget.prototype.dispatchEvent.call(port2, new Event("close"));
    EventTarget.prototype.dispatchEvent.call(port2, new Event("close"));
    await settle();
    expect(closes).toBe(1);
    expect(port2.closed).toBe(true);
  });

  it("tells the other end with the platform's own postMessage, unseen by a program's spy", async () => {
    const [port1, port2] = channel();
    let closes = 0;
    port2.on("message", () => {});
    port2.on("close", () => {
      closes += 1;
    });
    const posted: unknown[] = [];
    const original = FakePort.prototype.postMessage;
    FakePort.prototype.postMessage = function (data: unknown) {
      posted.push(data);
    };
    try {
      port1.close();
      await settle();
    } finally {
      FakePort.prototype.postMessage = original;
    }
    expect(posted).toEqual([]);
    expect(closes).toBe(1);
  });

  it("posts nothing to a peer that speaks its own protocol through onmessage", async () => {
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    port2.onmessage = (event) => seen.push(event.data);
    port1.onmessage = () => {};
    port1.close();
    await turn();
    expect(seen).toEqual([]);
  });

  it("posts nothing to the peer of a port the platform listens on", async () => {
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    listenOnPlatformPort(port2 as unknown as MessagePort, (event) => seen.push(event.data));
    listenOnPlatformPort(port1 as unknown as MessagePort, () => {});
    port1.postMessage("one of its own");
    port1.close();
    await settle();
    expect(seen).toEqual(["one of its own"]);
  });

  it("still delivers what it had received when its own listener closes it, then emits 'close'", async () => {
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    port1.on("message", (value) => {
      seen.push(value);
      if (value === 2) {
        port1.close();
        seen.push("closed");
        port1.postMessage("from the closed port");
      }
    });
    port1.on("close", () => seen.push("close"));
    port2.on("message", (value) => seen.push(`peer got ${String(value)}`));
    for (const value of [1, 2, 3, 4]) port2.postMessage(value);
    await settle();
    expect(seen).toEqual([1, 2, "closed", 3, 4, "close"]);
    expect(port1.closed).toBe(true);
    expect(port2.closed).toBe(true);
    expect(fake.refCount).toBe(0);
  });

  it("delivers what it had received when a tick of its listener closes it", async () => {
    const nodeProcess = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    port1.on("message", (value) => {
      seen.push(value);
      if (value === 1) {
        nodeProcess.nextTick(() => port1.close());
      }
    });
    port1.on("close", () => seen.push("close"));
    for (const value of [1, 2, 3]) port2.postMessage(value);
    await settle();
    expect(seen).toEqual([1, 2, 3, "close"]);
  });

  it("delivers what it had received when a tick queued after its listener, in the same task, closes it", async () => {
    const nodeProcess = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1] = channel();
    const seen: unknown[] = [];
    port1.on("message", (value) => seen.push(value));
    // Behind the port's own listener in the same dispatch: where a browser
    // runs the promise jobs of the listener.
    EventTarget.prototype.addEventListener.call(port1, "message", (event) => {
      if ((event as MessageEvent).data === 2) {
        nodeProcess.nextTick(() => {
          port1.close();
          seen.push("closed");
        });
      }
    });
    port1.on("close", () => seen.push("close"));
    deliverEachAsBrowser(port1, [1, 2, 3, 4]);
    await settle();
    expect(seen).toEqual([1, 2, "closed", 3, 4, "close"]);
  });

  it("closes at once from a tick a later task queued", async () => {
    const nodeProcess = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    port1.on("message", (value) => {
      seen.push(value);
      if (value === 1) {
        setTimeout(() =>
          nodeProcess.nextTick(() => {
            port1.close();
            seen.push("closed");
            port2.postMessage("after close");
          }),
        );
      }
    });
    port1.on("close", () => seen.push("close"));
    port2.postMessage(1);
    await settle();
    expect(seen).toEqual([1, "closed", "close"]);
  });

  it("holds the process until 'close' when its listener closes it after unref()", async () => {
    const [port1, port2] = channel();
    let closes = 0;
    port1.on("message", () => {
      port1.unref();
      port1.close();
    });
    port1.on("close", () => {
      closes += 1;
    });
    port2.postMessage(1);
    await turn();
    expect(fake.refCount).toBe(1);
    await settle();
    expect(closes).toBe(1);
    expect(fake.refCount).toBe(0);
  });

  it("refuses to transfer a closed port, as Node does", () => {
    const [port1] = channel();
    const [other] = channel();
    port1.close();
    expect(() => other.postMessage(port1, [port1])).toThrow(
      expect.objectContaining({
        name: "DataCloneError",
        message: "MessagePort in transfer list is already detached",
      }),
    );
    expect(() => other.postMessage(port1, { transfer: [port1] })).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
  });

  it("emits 'close' on an end with only a 'close' listener when its peer closes, holding nothing", async () => {
    for (const listen of ["on", "addEventListener"] as const) {
      const [port1, port2] = channel();
      const seen: string[] = [];
      if (listen === "on") {
        port2.on("close", () => seen.push("close"));
      } else {
        port2.addEventListener("close", () => seen.push("close"));
      }
      expect(fake.refCount).toBe(0);
      port1.close();
      await settle();
      expect([listen, seen, fake.refCount]).toEqual([listen, ["close"], 0]);
    }
  });

  it("keeps what came before the peer's close for a later listener, and emits 'close' after it", async () => {
    const nodeProcess = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    port2.on("close", () => seen.push("close"));
    port1.postMessage(1);
    port1.postMessage(2);
    port1.close();
    await settle();
    // Nobody listens: nothing is delivered, the process is not held, and the close waits.
    expect([seen, fake.refCount]).toEqual([[], 0]);
    port2.on("message", (value) => {
      seen.push(value);
      nodeProcess.nextTick(() => seen.push(`tick ${String(value)}`));
    });
    await settle();
    expect(seen).toEqual([1, "tick 1", 2, "tick 2", "close"]);
  });

  it("emits a peer's close that waited once start() drops what waited with it", async () => {
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    port2.on("close", () => seen.push("close"));
    port1.postMessage(1);
    port1.close();
    await settle();
    seen.push("|");
    port2.start();
    await settle();
    port2.on("message", (value) => seen.push(value));
    await settle();
    expect(seen).toEqual(["|", "close"]);
  });

  it("emits a peer's close behind the messages a stopped port holds", async () => {
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    const listener = (value: unknown) => seen.push(value);
    port2.on("message", listener);
    port2.on("close", () => seen.push("close"));
    port1.postMessage(1);
    await settle();
    port2.off("message", listener);
    port1.postMessage(2);
    port1.postMessage(3);
    port1.close();
    await settle();
    seen.push("|");
    port2.on("message", listener);
    await settle();
    expect(seen).toEqual([1, "|", 2, 3, "close"]);
  });

  it("refuses a closed or closing port in structuredClone's transfer list, as Node does", async () => {
    const detached = expect.objectContaining({
      name: "DataCloneError",
      message: "MessagePort in transfer list is already detached",
      code: 25,
    });
    const [closed] = channel();
    const [open] = channel();
    closed.close();
    expect(() => refuseClosedPortsToClone({ transfer: [open, closed] })).toThrow(detached);
    expect(() => refuseClosedPortsToClone({ transfer: [open] })).not.toThrow();
    expect(() => refuseClosedPortsToClone(undefined)).not.toThrow();
    // Options, not a transfer list: an array has no `transfer`.
    expect(() => refuseClosedPortsToClone([closed])).not.toThrow();
    const [closing, peer] = channel();
    const results: unknown[] = [];
    closing.on("message", () => {
      closing.close();
      try {
        refuseClosedPortsToClone({ transfer: [closing] });
        results.push("cloned");
      } catch (error) {
        results.push(error);
      }
    });
    peer.postMessage(1);
    await settle();
    expect(results).toEqual([detached]);
  });

  it("recognises the close message", () => {
    expect(isPortCloseMessage({ __webnodePortClose__: true })).toBe(true);
    expect(isPortCloseMessage({ type: "message" })).toBe(false);
    expect(isPortCloseMessage(null)).toBe(false);
  });
});

describe("MessagePort refs", () => {
  it("onmessage and addEventListener('message') hold the process like on('message')", () => {
    const [port1, port2] = channel();
    port1.onmessage = () => {};
    expect(fake.refCount).toBe(1);
    const listener = () => {};
    port2.addEventListener("message", listener);
    expect(fake.refCount).toBe(2);
    // A second listener of another kind takes no second ref.
    port2.on("message", () => {});
    expect(fake.refCount).toBe(2);
    port1.onmessage = null;
    expect(fake.refCount).toBe(1);
    port2.removeEventListener("message", listener);
    expect(fake.refCount).toBe(1);
    port2.unref();
    expect(fake.refCount).toBe(0);
  });

  it("lets go after a once listener's message, and delivers it", async () => {
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    port2.addEventListener("message", (event) => seen.push((event as MessageEvent).data), {
      once: true,
    });
    expect(fake.refCount).toBe(1);
    port1.postMessage("late");
    await turn();
    expect(seen).toEqual(["late"]);
    expect(fake.refCount).toBe(0);
  });

  it("does not hold the process for a platform port's handler", () => {
    const [port1] = channel();
    listenOnPlatformPort(port1 as unknown as MessagePort, () => {});
    expect(fake.refCount).toBe(0);
  });
});

describe("MessagePort messages are macrotasks", () => {
  const tickOrder = async (listen: (port: NodePort, run: () => void) => void) => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1, port2] = channel();
    const order: string[] = [];
    listen(port2, () => {
      void Promise.resolve().then(() => order.push("promise"));
      process.nextTick(() => order.push("tick"));
      order.push("message");
    });
    port1.postMessage("go");
    await turn();
    await turn();
    port2.close();
    return order;
  };

  it("runs the ticks an on('message') listener queues before its promise jobs", async () => {
    expect(await tickOrder((port, run) => port.on("message", run))).toEqual([
      "message",
      "tick",
      "promise",
    ]);
  });

  it("runs the ticks an onmessage handler queues before its promise jobs", async () => {
    expect(
      await tickOrder((port, run) => {
        port.onmessage = run;
      }),
    ).toEqual(["message", "tick", "promise"]);
  });

  it("runs the ticks an addEventListener('message') listener queues before its promise jobs", async () => {
    expect(await tickOrder((port, run) => port.addEventListener("message", run))).toEqual([
      "message",
      "tick",
      "promise",
    ]);
  });

  it("reads onmessage back as the handler the program set", () => {
    const [port1] = channel();
    const handler = () => {};
    port1.onmessage = handler;
    expect(port1.onmessage).toBe(handler);
    port1.onmessage = null;
    expect(port1.onmessage).toBe(null);
  });

  it("calls every listener of one message, of every kind, in one macrotask", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1, port2] = channel();
    const order: string[] = [];
    const mark = (tag: string) => {
      order.push(tag);
      process.nextTick(() => order.push(`${tag}>t`));
      void Promise.resolve().then(() => order.push(`${tag}>p`));
    };
    port2.on("message", (value) => mark(`A${String(value)}`));
    port2.addEventListener("message", (event) => mark(`B${String((event as MessageEvent).data)}`));
    port2.onmessage = (event) => mark(`C${String(event.data)}`);
    port1.postMessage(1);
    await turn();
    await turn();
    port2.close();
    // The order real Node v26 prints.
    expect(order).toEqual(["A1", "B1", "C1", "A1>t", "B1>t", "C1>t", "A1>p", "B1>p", "C1>p"]);
  });

  it("gives nothing to a listener removed, or a port closed, by ticks the message waited behind", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const seen: string[] = [];
    const [portA] = channel();
    const [portB] = channel();
    const [portC] = channel();
    const onA = (value: unknown) => seen.push(`A:${String(value)}`);
    const onB = (event: Event) => seen.push(`B:${String((event as MessageEvent).data)}`);
    portA.on("message", onA);
    portB.addEventListener("message", onB);
    portC.onmessage = (event) => seen.push(`C:${String(event.data)}`);
    portC.on("message", (value) => seen.push(`C2:${String(value)}`));
    await Promise.resolve();
    // Queued from a promise job: it waits for the turn, and so do the messages below.
    process.nextTick(() => {
      (portA as unknown as { off: (event: string, listener: unknown) => void }).off("message", onA);
      portB.removeEventListener("message", onB);
      portC.close();
    });
    for (const port of [portA, portB, portC]) {
      EventTarget.prototype.dispatchEvent.call(port, new MessageEvent("message", { data: "x" }));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([]);
    portA.close();
    portB.close();
  });

  it("runs the listeners of a program's own dispatchEvent at once, even while ticks wait", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1] = channel();
    const order: string[] = [];
    port1.on("message", (value) => order.push(`listener:${String(value)}`));
    await Promise.resolve();
    process.nextTick(() => order.push("tick"));
    port1.dispatchEvent(new MessageEvent("message", { data: 1 }));
    order.push("after dispatch");
    expect(order).toEqual(["listener:1", "after dispatch"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["listener:1", "after dispatch", "tick"]);
    port1.close();
  });
});

describe("MessagePort listeners, as Node's port has them", () => {
  it("starts the port for a first 'message' listener of any kind", () => {
    const listen: [string, (port: NodePort) => void][] = [
      ["on", (port) => port.on("message", () => {})],
      ["once", (port) => port.once("message", () => {})],
      ["addEventListener", (port) => port.addEventListener("message", () => {})],
      [
        "onmessage",
        (port) => {
          port.onmessage = () => {};
        },
      ],
    ];
    for (const [kind, add] of listen) {
      const [port] = channel();
      expect([kind, port.started]).toEqual([kind, false]);
      add(port);
      expect([kind, port.started]).toEqual([kind, true]);
      port.close();
    }
    // A listener of another event does not ('close' is below).
    const [quiet] = channel();
    quiet.on("messageerror", () => {});
    quiet.addEventListener("messageerror", () => {});
    expect(quiet.started).toBe(false);
  });

  it("gives a message to no listener an earlier listener of it removed, nor to one it added", async () => {
    const [port1, port2] = channel();
    const seen: string[] = [];
    const second = (value: unknown) => seen.push(`second:${String(value)}`);
    const third = (event: Event) => seen.push(`third:${String((event as MessageEvent).data)}`);
    port2.on("message", (value) => {
      seen.push(`first:${String(value)}`);
      if (value === 1) {
        port2.off("message", second);
        port2.removeEventListener("message", third);
        port2.on("message", (later) => seen.push(`added:${String(later)}`));
      }
    });
    port2.on("message", second);
    port2.addEventListener("message", third);
    port1.postMessage(1);
    port1.postMessage(2);
    await settle();
    // The order real Node v26 prints.
    expect(seen).toEqual(["first:1", "first:2", "added:2"]);
    port2.close();
  });

  it("stops at stopImmediatePropagation, and the event loop still runs what the listener queued", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    // More messages than a port delivers before the event loop's own
    // listeners follow its one: those must not be stopped with the program's.
    const messages = 40;
    const one = async (listeners: number) => {
      const [port1, port2] = channel();
      const order: string[] = [];
      port2.addEventListener("message", (event) => {
        order.push("first");
        event.stopImmediatePropagation();
        void Promise.resolve().then(() =>
          process.nextTick(() => order.push("tick of a promise job")),
        );
      });
      if (listeners > 1) {
        port2.on("message", () => order.push("second"));
      }
      for (let sent = 0; sent < messages; sent += 1) {
        port1.postMessage(sent);
        await turn();
      }
      await settle();
      port2.close();
      return order.join(",");
    };
    const expected = Array.from({ length: messages }, () => "first,tick of a promise job").join(
      ",",
    );
    expect(await one(1)).toBe(expected);
    expect(await one(2)).toBe(expected);
  });

  it("delivers every message once, in order, however many a port carries", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    let ticks = 0;
    port2.on("message", (value) => {
      seen.push(value);
      process.nextTick(() => {
        ticks += 1;
      });
    });
    const sent = Array.from({ length: 100 }, (_, index) => index);
    for (const value of sent) {
      port1.postMessage(value);
    }
    await settle();
    expect(seen).toEqual(sent);
    expect(ticks).toBe(100);
    port2.close();
  });

  it("holds what comes after its last listener went for the next one, in order", async () => {
    const [port1, port2] = channel();
    const seen: string[] = [];
    const first = (value: unknown) => {
      seen.push(`first:${String(value)}`);
      port2.off("message", first);
    };
    port2.on("message", first);
    for (const value of [1, 2, 3]) {
      port1.postMessage(value);
    }
    await settle();
    expect(seen).toEqual(["first:1"]);
    // Stopped: nothing listens, so nothing holds the process.
    expect(fake.refCount).toBe(0);
    port2.addEventListener("message", (event) =>
      seen.push(`second:${String((event as MessageEvent).data)}`),
    );
    port1.postMessage(4);
    await settle();
    // The order real Node v26 prints.
    expect(seen).toEqual(["first:1", "second:2", "second:3", "second:4"]);
    port2.close();
  });

  it("gives each held message its own macrotask, and stops again when a once listener goes", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const [port1, port2] = channel();
    const order: string[] = [];
    const take = () =>
      port2.once("message", (value) => {
        order.push(`message:${String(value)}`);
        process.nextTick(() => order.push(`tick:${String(value)}`));
      });
    take();
    for (const value of [1, 2, 3]) {
      port1.postMessage(value);
    }
    await settle();
    expect(order).toEqual(["message:1", "tick:1"]);
    take();
    await settle();
    expect(order).toEqual(["message:1", "tick:1", "message:2", "tick:2"]);
    port2.on("message", (value) => {
      order.push(`message:${String(value)}`);
      process.nextTick(() => order.push(`tick:${String(value)}`));
    });
    await settle();
    expect(order.slice(4)).toEqual(["message:3", "tick:3"]);
    port2.close();
  });

  it("drops what waited when the program starts a port nobody listens to", async () => {
    const [port1, port2] = channel();
    const seen: unknown[] = [];
    const first = () => port2.off("message", first);
    port2.on("message", first);
    port1.postMessage(1);
    port1.postMessage(2);
    await settle();
    port2.start();
    port2.on("message", (value) => seen.push(value));
    port1.postMessage(3);
    await settle();
    expect(seen).toEqual([3]);
    port2.close();
  });
});

describe("MessagePort transfer", () => {
  /** Makes `port` hold what comes for its next listener, the way `mode` names. */
  function hold(port: NodePort, mode: string, seen: unknown[]): void {
    if (mode === "close-only") {
      port.on("close", () => {});
    } else if (mode === "off") {
      const listener = () => {};
      port.on("message", listener);
      port.off("message", listener);
    } else {
      port.once("message", (value: unknown) => seen.push(`once:${String(value)}`));
    }
  }

  const ways = {
    "a port's postMessage": (port: NodePort) =>
      new Promise<NodePort>((resolve) => {
        const [carrier, receiver] = channel();
        receiver.on("message", (moved: unknown) => resolve(moved as NodePort));
        carrier.postMessage({ port }, [port]);
      }).then((moved) => (moved as unknown as { port: NodePort }).port),
    structuredClone: (port: NodePort) =>
      Promise.resolve(
        (
          cloneWithPorts(
            (value, options) => transferPorts(value, options),
            { port },
            {
              transfer: [port as unknown as Transferable],
            },
          ) as { port: NodePort }
        ).port,
      ),
  };

  for (const mode of ["close-only", "off", "once"]) {
    for (const [way, transfer] of Object.entries(ways)) {
      it(`moves what a port held (${mode}) with it through ${way}, ahead of what comes later`, async () => {
        const [port1, port2] = channel();
        const seen: unknown[] = [];
        hold(port1, mode, seen);
        port2.postMessage(1);
        port2.postMessage(2);
        // Both arrive in immediates queued before this one's.
        await turn();
        const moved = await transfer(port1);
        port2.postMessage(3);
        moved.on("message", (value: unknown) => seen.push(value));
        await until(() => seen.includes(3));
        // What real Node v26 delivers.
        expect(seen).toEqual(mode === "once" ? ["once:1", 2, 3] : [1, 2, 3]);
        moved.close();
      });
    }
  }

  it("keeps what a port held when its transfer fails", async () => {
    const [port1, port2] = channel();
    hold(port1, "off", []);
    port2.postMessage(1);
    await turn();
    expect(() =>
      cloneWithPorts(
        () => {
          throw new DOMException("could not be cloned", "DataCloneError");
        },
        port1,
        { transfer: [port1 as unknown as Transferable] },
      ),
    ).toThrow(expect.objectContaining({ name: "DataCloneError" }));
    const seen: unknown[] = [];
    port1.on("message", (value: unknown) => seen.push(value));
    await until(() => seen.length > 0);
    expect(seen).toEqual([1]);
    port1.close();
  });

  it("posts a port that holds nothing as the program gave it", async () => {
    const [carrier, receiver] = channel();
    const [port1] = channel();
    const seen: unknown[] = [];
    receiver.on("message", (value: unknown) => seen.push(value));
    carrier.postMessage({ n: 1 }, []);
    carrier.postMessage({ port1 }, [port1]);
    await until(() => seen.length === 2);
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual({ n: 1 });
    expect(Object.keys(seen[1] as object)).toEqual(["port1"]);
    carrier.close();
  });
});

/** A BroadcastChannel stand-in: a message reaches every other open channel of the name. */
class FakeBroadcast extends EventTarget {
  static open = new Set<FakeBroadcast>();
  closed = false;
  readonly name: string;
  #handler: ((event: MessageEvent) => void) | null = null;

  constructor(name: string) {
    super();
    this.name = name;
    FakeBroadcast.open.add(this);
  }

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.#handler;
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    if (this.#handler) {
      this.removeEventListener("message", this.#handler as EventListener);
    }
    this.#handler = handler;
    if (handler) {
      this.addEventListener("message", handler as EventListener);
    }
  }

  postMessage(data: unknown): void {
    for (const other of FakeBroadcast.open) {
      if (other !== this && other.name === this.name) {
        setImmediate(() => {
          if (!other.closed) {
            deliver(other, data);
          }
        });
      }
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcast.open.delete(this);
  }
}
addNodePortInterface(FakeBroadcast.prototype, "broadcast");

describe("BroadcastChannel", () => {
  afterEach(() => {
    FakeBroadcast.open.clear();
  });

  it("closes alone: the other channels of its name go on", async () => {
    const a = new FakeBroadcast("x");
    const b = new FakeBroadcast("x");
    const c = new FakeBroadcast("x");
    const seen: string[] = [];
    b.onmessage = (event) => seen.push(`b:${String(event.data)}`);
    c.addEventListener("message", (event) =>
      seen.push(`c:${String((event as MessageEvent).data)}`),
    );
    for (const channel of [a, b, c]) {
      channel.addEventListener("close", () => seen.push("a 'close' event"));
    }
    a.postMessage(1);
    await settle();
    a.close();
    b.postMessage(2);
    await settle();
    // The order real Node v26 prints.
    expect(seen).toEqual(["b:1", "c:1", "c:2"]);
    expect([b.closed, c.closed]).toEqual([false, false]);
  });

  it("is an EventTarget with ref, unref and close, not an emitter, as Node's is", () => {
    const channel = new FakeBroadcast("x") as unknown as Record<string, unknown>;
    expect(
      ["on", "once", "off", "emit", "ref", "unref", "close"].map(
        (name) => `${name}:${typeof channel[name]}`,
      ),
    ).toEqual([
      "on:undefined",
      "once:undefined",
      "off:undefined",
      "emit:undefined",
      "ref:function",
      "unref:function",
      "close:function",
    ]);
  });

  it("takes a message shaped like a port's close message as data", async () => {
    const a = new FakeBroadcast("x");
    const b = new FakeBroadcast("x");
    const seen: unknown[] = [];
    b.onmessage = (event) => seen.push(event.data);
    a.postMessage({ __webnodePortClose__: true });
    await settle();
    expect(seen).toEqual([{ __webnodePortClose__: true }]);
    expect(b.closed).toBe(false);
  });

  it("does not hold or release the process for its listeners: ref() and unref() decide", () => {
    const channel = new FakeBroadcast("x") as FakeBroadcast & NodePort;
    channel.ref();
    expect(fake.refCount).toBe(1);
    channel.unref();
    const listener = () => {};
    channel.addEventListener("message", listener);
    channel.onmessage = () => {};
    expect(fake.refCount).toBe(0);
    channel.ref();
    channel.removeEventListener("message", listener);
    channel.onmessage = null;
    expect(fake.refCount).toBe(1);
    channel.close();
    expect(fake.refCount).toBe(0);
  });
});

/** A platform BroadcastChannel that joins its name only a while after it is made, as a browser's does. */
class LateBroadcast extends FakeBroadcast {
  constructor(name: string) {
    super(name);
    FakeBroadcast.open.delete(this);
    setTimeout(() => {
      if (!this.closed) {
        FakeBroadcast.open.add(this);
      }
    }, 5);
  }
}

describe("the process's BroadcastChannel", () => {
  afterEach(() => {
    FakeBroadcast.open.clear();
  });

  const Channel = () =>
    processBroadcastChannel(
      LateBroadcast as unknown as typeof BroadcastChannel,
      createBroadcastHub(),
    );

  it("delivers what is posted right after a channel is made, though the platform joins it late", async () => {
    const BroadcastChannel = Channel();
    const a = new BroadcastChannel("x");
    const b = new BroadcastChannel("x");
    const seen: unknown[] = [];
    b.onmessage = (event) => seen.push(event.data);
    a.postMessage(1);
    await until(() => seen.length > 0);
    expect(seen).toEqual([1]);
    a.close();
    b.close();
  });

  it("refuses a post after close and one with no message, as Node does", () => {
    const BroadcastChannel = Channel();
    const channel = new BroadcastChannel("x");
    expect(() => (channel.postMessage as () => void)()).toThrow(
      expect.objectContaining({ code: "ERR_MISSING_ARGS" }),
    );
    channel.close();
    expect(() => channel.postMessage(1)).toThrow(
      expect.objectContaining({
        name: "InvalidStateError",
        message: "BroadcastChannel is closed.",
      }),
    );
  });

  it("holds the process from construction until close()", () => {
    const BroadcastChannel = Channel();
    const channel = new BroadcastChannel("x");
    expect(fake.refCount).toBe(1);
    channel.close();
    expect(fake.refCount).toBe(0);
  });
});

describe("Worker exit", () => {
  function startWorker() {
    const [parentEnd, threadEnd] = channel();
    const exits: ((code: number) => void)[] = [];
    let terminated = false;
    Object.assign(fake, {
      threads: {
        ...fake.threads,
        spawn: () => ({
          threadId: 7,
          port: parentEnd,
          onExit: (listener: (code: number) => void) => exits.push(listener),
          terminate: () => {
            terminated = true;
          },
        }),
      },
    });
    const worker = new Worker("/w.js");
    const events: unknown[][] = [];
    worker.on("message", (value: unknown) => events.push(["message", value]));
    worker.on("error", (error: Error) => events.push(["error", error.message]));
    worker.on("exit", (code: number) => events.push(["exit", code]));
    return {
      worker,
      events,
      parentEnd,
      threadEnd,
      exit: (code: number) => exits.forEach((listener) => listener(code)),
      terminated: () => terminated,
    };
  }

  it("emits what the thread posted before 'exit', even when the exit is reported first", async () => {
    const { events, threadEnd, exit } = startWorker();
    threadEnd.postMessage("x".repeat(200000).length);
    threadEnd.postMessage({ type: THREAD_EXIT_MESSAGE });
    exit(0);
    expect(events).toEqual([]);
    await turn();
    await turn();
    expect(events).toEqual([
      ["message", 200000],
      ["exit", 0],
    ]);
    expect(fake.refCount).toBe(0);
  });

  it("gives 'error' the thread's uncaught error as Node rebuilds it", async () => {
    const { worker, threadEnd } = startWorker();
    const errors: unknown[] = [];
    worker.on("error", (error: unknown) => errors.push(error));
    const failure = Object.assign(new RangeError("boom"), {
      code: "E_X",
      extra: { list: [1, 2] },
      fn: () => 1,
    });
    threadEnd.postMessage(threadErrorMessage(failure));
    threadEnd.postMessage(threadErrorMessage({ code: "plain", n: 1 }));
    class Mine extends TypeError {
      code = "C";
      constructor() {
        super("mine");
        this.name = "Mine";
      }
    }
    threadEnd.postMessage(threadErrorMessage(new Mine()));
    await turn();
    await turn();
    const [error, plain, mine] = errors as [
      RangeError & { code?: string; extra?: unknown },
      unknown,
      Error,
    ];
    // node: `e instanceof RangeError`, Object.keys(e) is ["code", "extra"]:
    // the error's own properties that can be cloned, not its name or stack.
    expect([
      error instanceof RangeError,
      error.name,
      error.message,
      error.stack,
      Object.keys(error),
      error.code,
      error.extra,
    ]).toEqual([
      true,
      "RangeError",
      "boom",
      failure.stack,
      ["code", "extra"],
      "E_X",
      { list: [1, 2] },
    ]);
    // What was thrown and is no error arrives as it is.
    expect(plain).toEqual({ code: "plain", n: 1 });
    // A class of the program's own arrives as the language's nearest, with
    // the name its constructor gave it among its keys.
    expect([
      mine instanceof TypeError,
      mine.constructor.name,
      mine.name,
      Object.keys(mine),
    ]).toEqual([true, "TypeError", "Mine", ["code", "name"]]);
  });

  it("ends at once for a terminated thread", async () => {
    const { worker, events, exit, terminated } = startWorker();
    const done = worker.terminate();
    expect(terminated()).toBe(true);
    exit(1);
    expect(await done).toBe(1);
    expect(events).toEqual([["exit", 1]]);
  });

  it("stops waiting for a thread that ended without its last message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { events, exit } = startWorker();
      exit(3);
      expect(events).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(events).toEqual([["exit", 3]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Worker standard streams", () => {
  const open: MessagePort[] = [];
  afterEach(() => {
    for (const port of open.splice(0)) {
      port.close();
    }
  });

  /**
   * A Worker over a real channel, and its thread's side as the thread's own
   * worker has it: the same module, told of the thread's `process`.
   */
  function start(options: { stdin?: boolean; stdout?: boolean; stderr?: boolean }) {
    const { port1: parentEnd, port2: threadEnd } = new MessageChannel();
    open.push(parentEnd, threadEnd);
    const exits: ((code: number) => void)[] = [];
    let request: ThreadSpawnRequest | undefined;
    const main = fake.threads;
    Object.assign(fake, {
      threads: {
        ...main,
        spawn: (spawned: ThreadSpawnRequest) => {
          request = spawned;
          return {
            threadId: 7,
            port: parentEnd,
            onExit: (listener: (code: number) => void) => exits.push(listener),
            terminate: () => {},
          };
        },
      },
    });
    const worker = new Worker("/w.js", { workerData: { n: 1 }, ...options });
    const events: unknown[][] = [];
    worker.on("message", (value: unknown) => events.push(["message", value]));
    worker.on("exit", (code: number) => events.push(["exit", code]));
    const thread: { stdout?: Writable; stderr?: Writable; stdin?: Readable } = {};
    const asThread = <T>(run: () => T): T => {
      Object.assign(fake, {
        threads: {
          ...main,
          isMainThread: false,
          workerData: request?.workerData,
          parentPort: threadEnd,
        },
      });
      try {
        return run();
      } finally {
        Object.assign(fake, { threads: main });
      }
    };
    asThread(() => connectProcess(thread as unknown as NodeProcess));
    const exit = (code: number) => {
      threadEnd.postMessage({ type: THREAD_EXIT_MESSAGE });
      exits.forEach((listener) => listener(code));
    };
    return { worker, events, thread, threadEnd, asThread, exit };
  }

  const text = (stream: Readable) => {
    const seen = { text: "", events: [] as string[] };
    stream.on("data", (chunk: Uint8Array) => (seen.text += Buffer.from(chunk).toString()));
    stream.on("end", () => seen.events.push("end"));
    return seen;
  };

  it("keeps the streams asked for: the thread's writes arrive before 'exit', the streams end after", async () => {
    const { worker, events, thread, threadEnd, exit } = start({ stdout: true, stderr: true });
    expect(worker.stdin).toBe(null);
    const out = text(worker.stdout);
    const err = text(worker.stderr);
    worker.on("exit", () => events.push(["at exit", out.text, err.text, [...out.events]]));
    thread.stdout?.write("to stdout\n");
    threadEnd.postMessage("between");
    thread.stderr?.write("to stderr\n");
    exit(0);
    await settle();
    expect(events).toEqual([
      ["message", "between"],
      ["exit", 0],
      ["at exit", "to stdout\n", "to stderr\n", []],
    ]);
    expect([out.events, err.events]).toEqual([["end"], ["end"]]);
  });

  it("gives the thread its Worker's workerData, not what carries it", () => {
    const { asThread } = start({ stdout: true });
    expect(workerThreads.workerData).toBe(null);
    expect(asThread(() => workerThreads.workerData)).toEqual({ n: 1 });
  });

  it("leaves the streams not asked for to the process, and ends the Worker's with the thread", async () => {
    const { worker, thread, exit } = start({});
    expect("stdout" in thread || "stderr" in thread).toBe(false);
    const out = text(worker.stdout);
    // It ends by itself, as Node's does while it is piped to the process's own.
    let ended = false;
    worker.stderr.on("end", () => {
      ended = true;
    });
    exit(0);
    await settle();
    expect([out.text, out.events, ended]).toEqual(["", ["end"], true]);
  });

  it("does not read a kept stream for the program: its 'end' waits for a reader", async () => {
    const { worker, thread, exit } = start({ stdout: true });
    let ended = false;
    worker.stdout.on("end", () => {
      ended = true;
    });
    thread.stdout?.write("unread");
    exit(0);
    await settle();
    expect([ended, worker.stdout.readableLength]).toEqual([false, 6]);
    worker.stdout.resume();
    await settle();
    expect(ended).toBe(true);
  });

  it("writes the thread's stdin when asked to", async () => {
    const { worker, thread, exit } = start({ stdin: true });
    const input = text(thread.stdin as Readable);
    (worker.stdin as Writable).end("typed");
    await settle();
    expect([input.text, input.events]).toEqual(["typed", ["end"]]);
    exit(0);
    await settle();
  });
});

describe("Worker under watch mode", () => {
  function watchedWorker(env: Record<string, string>, connected: boolean) {
    Object.assign(fake.env, env);
    const [parentEnd] = channel();
    Object.assign(fake, {
      threads: {
        ...fake.threads,
        spawn: () => ({ threadId: 7, port: parentEnd, onExit: () => {}, terminate: () => {} }),
      },
    });
    const worker = new Worker("/w.js");
    const messages: unknown[] = [];
    worker.on("message", (value: unknown) => messages.push(value));
    const sent: unknown[] = [];
    // The process this worker runs, as `installGlobals` tells the module.
    connectProcess({
      connected,
      send: (message: unknown) => sent.push(message),
    } as unknown as NodeProcess);
    const post = (data: unknown) => deliver(parentEnd, data);
    return { post, messages, sent };
  }

  it("passes a thread's reports on to the supervisor, and to the program too, as Node does", () => {
    const { post, messages, sent } = watchedWorker({ WATCH_REPORT_DEPENDENCIES: "1" }, true);
    post({ "watch:require": ["/app/dep.js"] });
    post({ "watch:import": ["file:///app/m.mjs"], other: 1 });
    post("hello");
    expect(sent).toEqual([
      { "watch:require": ["/app/dep.js"] },
      { "watch:import": ["file:///app/m.mjs"] },
    ]);
    expect(messages).toEqual([
      { "watch:require": ["/app/dep.js"] },
      { "watch:import": ["file:///app/m.mjs"], other: 1 },
      "hello",
    ]);
  });

  it("passes nothing on without a supervisor's channel or outside watch mode", () => {
    const unwatched = watchedWorker({}, true);
    unwatched.post({ "watch:require": ["/app/dep.js"] });
    expect(unwatched.sent).toEqual([]);
    const disconnected = watchedWorker({ WATCH_REPORT_DEPENDENCIES: "1" }, false);
    disconnected.post({ "watch:require": ["/app/dep.js"] });
    expect(disconnected.sent).toEqual([]);
    expect(disconnected.messages).toEqual([{ "watch:require": ["/app/dep.js"] }]);
  });

  it("sends through the process it was given, not one a program put in the global", () => {
    const { post, sent } = watchedWorker({ WATCH_REPORT_DEPENDENCIES: "1" }, true);
    const impostor: unknown[] = [];
    vi.stubGlobal("process", {
      connected: true,
      send: (message: unknown) => impostor.push(message),
    });
    try {
      post({ "watch:require": ["/app/dep.js"] });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(impostor).toEqual([]);
    expect(sent).toEqual([{ "watch:require": ["/app/dep.js"] }]);
  });
});

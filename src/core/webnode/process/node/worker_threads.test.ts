// @vitest-environment node
// Node's port interface on fake entangled ports: closing one end emits 'close'
// on the other and releases the ref its 'message' listener held.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import {
  addNodePortInterface,
  isPortCloseMessage,
  listenOnPlatformPort,
  THREAD_EXIT_MESSAGE,
  Worker,
} from "./worker_threads";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

/** A MessagePort stand-in: messages reach the peer in a later task, none after close. */
class FakePort extends EventTarget {
  peer: FakePort | null = null;
  closed = false;
  #handler: ((event: MessageEvent) => void) | null = null;

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

  start(): void {}

  postMessage(data: unknown): void {
    const peer = this.peer;
    if (this.closed || !peer) {
      return;
    }
    setImmediate(() => {
      if (!peer.closed) {
        peer.dispatchEvent(new MessageEvent("message", { data }));
      }
    });
  }

  close(): void {
    this.closed = true;
  }
}
addNodePortInterface(FakePort.prototype);

type NodePort = FakePort & {
  on(event: string, listener: (...args: unknown[]) => void): NodePort;
  close(): void;
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
    await turn();
    await turn();
    expect(messages).toEqual(["hello"]);
    expect(closes).toBe(1);
    expect(fake.refCount).toBe(0);
    expect(port2.closed).toBe(true);
  });

  it("emits 'close' once on the end that closes", () => {
    const [port1] = channel();
    let closes = 0;
    port1.on("message", () => {});
    port1.on("close", () => {
      closes += 1;
    });
    expect(fake.refCount).toBe(1);
    port1.close();
    port1.close();
    expect(closes).toBe(1);
    expect(fake.refCount).toBe(0);
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

// @vitest-environment node
// Node's port interface on fake entangled ports: closing one end emits 'close'
// on the other and releases the ref its 'message' listener held.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { addNodePortInterface, isPortCloseMessage } from "./worker_threads";

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

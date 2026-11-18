// @vitest-environment node
// A byte channel over a real MessagePort pair: what crosses it, how an end
// that paces itself is held to the other, and that the port never holds the
// process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_WINDOW, createPortChannel, paceOf } from "./byteChannel";
import type { ByteChannel } from "./process/runtime";

const open: MessagePort[] = [];

function pair(): [ByteChannel & { kill(): void }, ByteChannel & { kill(): void }] {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  return [createPortChannel(port1), createPortChannel(port2)];
}

afterEach(() => {
  for (const port of open.splice(0)) {
    port.close();
  }
});

/** Lets the messages posted so far, and the answers to them, arrive. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("a port channel", () => {
  it("carries bytes, end and destroy to the other end", async () => {
    const [a, b] = pair();
    const events: string[] = [];
    b.onData = (chunk) => events.push(`data ${Array.from(chunk).join(",")}`);
    b.onEnd = () => events.push("end");
    b.onClose = () => events.push("close");
    a.onClose = () => events.push("a close");
    a.write(new Uint8Array([1, 2, 3]));
    a.end();
    await settle();
    expect(events).toEqual(["data 1,2,3", "end"]);
    b.destroy();
    await settle();
    expect(events).toEqual(["data 1,2,3", "end", "close", "a close"]);
  });

  it("sends exactly the bytes written, not the memory behind a view of them", async () => {
    const [a, b] = pair();
    const received: Uint8Array[] = [];
    b.onData = (chunk) => received.push(chunk);
    const memory = new Uint8Array(1024 * 1024);
    memory.set([7, 8, 9], 100);
    const view = memory.subarray(100, 103);
    a.write(view);
    // The caller may reuse its buffer at once.
    memory.fill(0);
    await settle();
    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([7, 8, 9]);
    expect(received[0].buffer.byteLength).toBe(3);
  });

  it("copies a chunk that is the whole of its buffer, and leaves the caller's buffer usable", async () => {
    const [a, b] = pair();
    const received: Uint8Array[] = [];
    b.onData = (chunk) => received.push(chunk);
    const whole = new Uint8Array([4, 5, 6]);
    a.write(whole);
    expect(whole.length).toBe(3);
    whole.fill(0);
    await settle();
    expect(received.map((chunk) => Array.from(chunk))).toEqual([[4, 5, 6]]);
  });

  it("copies a chunk in shared memory instead of sharing it", async () => {
    const [a, b] = pair();
    const received: Uint8Array[] = [];
    b.onData = (chunk) => received.push(chunk);
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([1, 2, 3]);
    a.write(shared);
    shared.fill(9);
    await settle();
    expect(received.map((chunk) => Array.from(chunk))).toEqual([[1, 2, 3]]);
    expect(received[0].buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("does not hold the process: the socket that uses it does", () => {
    const { port1, port2 } = new MessageChannel();
    open.push(port1, port2);
    const unref = vi.spyOn(port1 as MessagePort & { unref(): void }, "unref");
    createPortChannel(port1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("reads the end of the stream, then the close, when the other end's thread is gone", async () => {
    const [a, b] = pair();
    const events: string[] = [];
    b.onEnd = () => events.push("end");
    b.onClose = () => events.push("close");
    a.onClose = () => events.push("a close");
    b.kill();
    expect(events).toEqual(["end", "close"]);
    await settle();
    // Nothing is posted to the end that is gone.
    expect(events).toEqual(["end", "close"]);

    const [c, d] = pair();
    d.onEnd = () => events.push("d end");
    d.onClose = () => events.push("d close");
    c.end();
    await settle();
    d.kill();
    d.kill();
    expect(events.slice(2)).toEqual(["d end", "d close"]);
  });

  it("gives no flow control for a channel it did not make", () => {
    const other: ByteChannel = {
      write() {},
      end() {},
      destroy() {},
      onData: null,
      onEnd: null,
      onClose: null,
    };
    expect(paceOf(other)).toBeUndefined();
  });
});

describe("an end that paces itself", () => {
  it("has a window of room, less what the other end has not taken", async () => {
    const [a, b] = pair();
    const writer = paceOf(a)!;
    const reader = paceOf(b)!;
    b.onData = () => {};
    expect(writer.room).toBe(CHANNEL_WINDOW);
    a.write(new Uint8Array(40_000));
    expect(writer.room).toBe(CHANNEL_WINDOW - 40_000);
    a.write(new Uint8Array(40_000));
    // Never negative, however far ahead the writer got.
    expect(writer.room).toBe(0);
    await settle();
    // The reader paces itself too: nothing counts as taken until it says so.
    expect(writer.room).toBe(0);
    reader.taken(80_000);
    await settle();
    expect(writer.room).toBe(CHANNEL_WINDOW);
  });

  it("is told once when there is room again", async () => {
    const [a, b] = pair();
    const writer = paceOf(a)!;
    const reader = paceOf(b)!;
    b.onData = () => {};
    a.write(new Uint8Array(CHANNEL_WINDOW));
    let calls = 0;
    writer.onRoom = () => {
      calls += 1;
    };
    await settle();
    expect(calls).toBe(0);
    reader.taken(CHANNEL_WINDOW);
    await settle();
    expect(calls).toBe(1);
    expect(writer.onRoom).toBeNull();
    reader.taken(CHANNEL_WINDOW);
    await settle();
    expect(calls).toBe(1);
  });

  it("reports what it took only once it amounts to half a window", async () => {
    const [a, b] = pair();
    const writer = paceOf(a)!;
    const reader = paceOf(b)!;
    b.onData = () => {};
    a.write(new Uint8Array(CHANNEL_WINDOW));
    await settle();
    reader.taken(CHANNEL_WINDOW / 2 - 1);
    await settle();
    expect(writer.room).toBe(0);
    reader.taken(1);
    await settle();
    expect(writer.room).toBe(CHANNEL_WINDOW / 2);
  });

  it("counts what reaches an end that does not pace itself as taken on delivery", async () => {
    const [a, b] = pair();
    const writer = paceOf(a)!;
    const got: number[] = [];
    b.onData = (chunk) => got.push(chunk.length);
    a.write(new Uint8Array(CHANNEL_WINDOW));
    expect(writer.room).toBe(0);
    await settle();
    expect(got).toEqual([CHANNEL_WINDOW]);
    expect(writer.room).toBe(CHANNEL_WINDOW);
  });

  it("stops reporting once the channel is closed", async () => {
    const [a, b] = pair();
    const reader = paceOf(b)!;
    a.destroy();
    await settle();
    expect(() => reader.taken(CHANNEL_WINDOW)).not.toThrow();
  });
});

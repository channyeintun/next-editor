// @vitest-environment node
// A Worker's kept standard streams, both ends over a real MessageChannel:
// what the thread's side posts, the parent's side receives.
import { setMaxListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { Buffer } from "./buffer";
import { createProcess } from "./process";
import type { Readable, Writable } from "./stream";
import { connectThreadStdio, createWorkerStdio, type KeptStdio } from "./threadStdio";

// The stdin port's one listener is followed by the event loop's own
// (eventLoop.ts `addMacrotaskListener`), more than Node expects on an EventTarget.
setMaxListeners(100);

let fake: FakeRuntime;
const open: MessagePort[] = [];

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  for (const port of open.splice(0)) {
    port.close();
  }
  setRuntime(null);
});

interface ThreadStreams {
  stdout?: Writable;
  stderr?: Writable;
  stdin?: Readable;
}

/** A Worker's streams and its thread's, joined as the thread's port joins them. */
function pair(kept: KeptStdio) {
  const { port1: parentEnd, port2: threadEnd } = new MessageChannel();
  open.push(parentEnd, threadEnd);
  const stdio = createWorkerStdio(kept);
  /** What the thread posted that was not for the streams. */
  const others: unknown[] = [];
  parentEnd.addEventListener("message", (event) => {
    if (!stdio.receive(event.data)) {
      others.push(event.data);
    }
  });
  parentEnd.start();
  const process: ThreadStreams = {};
  connectThreadStdio(process, kept, threadEnd);
  return { stdio, process, others, threadEnd };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function collect(stream: Readable): { chunks: unknown[]; events: string[] } {
  const seen = { chunks: [] as unknown[], events: [] as string[] };
  stream.on("data", (chunk: unknown) => seen.chunks.push(chunk));
  stream.on("end", () => seen.events.push("end"));
  return seen;
}

describe("a thread's stdout and stderr its Worker kept", () => {
  it("arrive in the Worker's streams, in order, as Buffers", async () => {
    const { stdio, process, others, threadEnd } = pair({
      stdin: false,
      stdout: true,
      stderr: true,
    });
    const out = collect(stdio.stdout);
    const err = collect(stdio.stderr);
    process.stdout?.write("one ");
    process.stdout?.write(Buffer.from("two "));
    process.stdout?.write("7468726565", "hex");
    process.stderr?.write("oops");
    threadEnd.postMessage("the program's own message");
    // Waited for, not timed: a port delivers when the machine gets to it, and a
    // busy one took longer than any fixed wait here.
    await vi.waitFor(() => {
      expect(Buffer.concat(out.chunks as Uint8Array[]).toString()).toBe("one two three");
      expect(Buffer.concat(err.chunks as Uint8Array[]).toString()).toBe("oops");
      expect(others).toEqual(["the program's own message"]);
    });
    expect(out.chunks.every((chunk) => Buffer.isBuffer(chunk))).toBe(true);
    expect(stdio.stdin).toBe(null);
  });

  it("hands every write over at once and leaves the writer's buffer whole", async () => {
    // Nobody reads the Worker's stream.
    const { stdio, process } = pair({ stdin: false, stdout: true, stderr: false });
    const pool = Buffer.alloc(64, "x");
    for (let written = 0; written < 100; written += 1) {
      expect(process.stdout?.write(Buffer.alloc(4096))).toBe(true);
    }
    process.stdout?.write(pool.subarray(8, 12));
    // Only the four bytes travel, in a buffer of their own.
    expect(pool.byteLength).toBe(64);
    await settle();
    expect(stdio.stdout.readableLength).toBe(100 * 4096 + 4);
    const chunks = collect(stdio.stdout).chunks as Uint8Array[];
    await settle();
    expect(chunks[chunks.length - 1].buffer.byteLength).toBe(4);
  });

  it("completes a write when the parent's stream asks for more, and holds the thread until then", async () => {
    const { stdio, process } = pair({ stdin: false, stdout: true, stderr: false });
    const completed: unknown[] = [];
    // More than the parent's stream holds before somebody reads it.
    for (const label of ["first", "second", "third"]) {
      process.stdout?.write(Buffer.alloc(40000), (error) => completed.push([label, error]));
    }
    expect(completed).toEqual([]);
    expect(fake.refCount).toBe(1);
    await settle();
    // The stream asked for more after the first chunk; the second filled it.
    expect(completed).toEqual([["first", null]]);
    expect(fake.refCount).toBe(1);
    stdio.stdout.resume();
    await settle();
    expect(completed.length).toBe(3);
    expect(fake.refCount).toBe(0);
  });

  it("completes a write though the program replaced process.nextTick, as fake timers do", async () => {
    const { stdio, process: thread } = pair({ stdin: false, stdout: true, stderr: true });
    stdio.stdout.resume();
    stdio.stderr.resume();
    let flushed = 0;
    const real = process.nextTick;
    // What a test that fakes nextTick and never runs its ticks leaves a stream with.
    process.nextTick = (() => {}) as typeof process.nextTick;
    try {
      thread.stdout?.write("", () => {
        flushed += 1;
      });
      thread.stderr?.write("late", "utf8", () => {
        flushed += 1;
      });
    } finally {
      process.nextTick = real;
    }
    await settle();
    expect(flushed).toBe(2);
  });

  it("answers a write after its end itself", async () => {
    const { process } = pair({ stdin: false, stdout: true, stderr: false });
    const errors: unknown[] = [];
    process.stdout?.on("error", (error: { code?: string }) => errors.push(["event", error.code]));
    process.stdout?.end();
    process.stdout?.write("late", (error) =>
      errors.push(["callback", (error as { code?: string })?.code]),
    );
    await settle();
    expect(errors).toContainEqual(["callback", "ERR_STREAM_WRITE_AFTER_END"]);
    expect(fake.refCount).toBe(0);
  });

  it("end when the thread ends them, or when the thread is gone", async () => {
    const { stdio, process } = pair({ stdin: false, stdout: true, stderr: true });
    const out = collect(stdio.stdout);
    const err = collect(stdio.stderr);
    process.stdout?.end("bye");
    await settle();
    expect([Buffer.concat(out.chunks as Uint8Array[]).toString(), out.events]).toEqual([
      "bye",
      ["end"],
    ]);
    expect(err.events).toEqual([]);
    stdio.end();
    stdio.end();
    await settle();
    expect(err.events).toEqual(["end"]);
    expect(out.events).toEqual(["end"]);
  });

  it("leave a stream the Worker did not keep to the process", async () => {
    const real = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const before = Object.getOwnPropertyDescriptor(real, "stderr")?.get;
    const { port2 } = new MessageChannel();
    open.push(port2);
    connectThreadStdio(real, { stdin: false, stdout: true, stderr: false }, port2);
    expect(Object.getOwnPropertyDescriptor(real, "stderr")?.get).toBe(before);
    expect(Object.getOwnPropertyDescriptor(real, "stdout")?.get).not.toBe(before);
    expect(real.stdout).toBe(real.stdout);
    // The Worker's stream for it has no data and ends with the thread.
    const stdio = createWorkerStdio({ stdin: false, stdout: true, stderr: false });
    const err = collect(stdio.stderr);
    stdio.end();
    await settle();
    expect([err.chunks, err.events]).toEqual([[], ["end"]]);
  });
});

describe("a thread's stdin", () => {
  it("is at its end from the start when the Worker did not keep it, as in Node", async () => {
    const { process } = pair({ stdin: false, stdout: false, stderr: false });
    const input = collect(process.stdin as Readable);
    await settle();
    expect([input.chunks, input.events]).toEqual([[], ["end"]]);
    expect(fake.refCount).toBe(0);
  });

  it("takes what the parent writes, before and after the thread's port has arrived", async () => {
    const { stdio, process } = pair({ stdin: true, stdout: false, stderr: false });
    const stdin = stdio.stdin as Writable;
    // Written before the thread's first message could have come.
    stdin.write("early ");
    const input = collect(process.stdin as Readable);
    await settle();
    stdin.write(Buffer.from("late"));
    await settle();
    expect(Buffer.concat(input.chunks as Uint8Array[]).toString()).toBe("early late");
    expect(input.events).toEqual([]);
    stdin.end();
    await settle();
    expect(input.events).toEqual(["end"]);
  });

  it("holds the thread while it is read, until the parent ends it", async () => {
    const { stdio, process } = pair({ stdin: true, stdout: false, stderr: false });
    const input = process.stdin as Readable;
    expect(fake.refCount).toBe(0);
    input.resume();
    await settle();
    expect(fake.refCount).toBe(1);
    (stdio.stdin as Writable).end();
    await settle();
    expect(fake.refCount).toBe(0);
  });
});

// @vitest-environment node
// FdReadable / FdWritable over the fake runtime: reading, end of stream, ref
// accounting (reading, pause, unref, end), writes in order, fd closing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import { FdReadable, FdWritable } from "./fdStreams";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

describe("FdReadable", () => {
  it("reads stdin until end of stream and holds a ref only while reading", async () => {
    const stdin = new FdReadable(0);
    expect(stdin.fd).toBe(0);
    const chunks: string[] = [];
    let ended = false;
    stdin.on("data", (chunk: Uint8Array) => chunks.push(Buffer.from(chunk).toString()));
    stdin.on("end", () => {
      ended = true;
    });
    await settle();
    expect(fake.refCount).toBe(1);
    fake.feedStdin("ab");
    fake.feedStdin("cd");
    await settle();
    expect(chunks.join("")).toBe("abcd");
    expect(fake.refCount).toBe(1);
    fake.feedStdin(null);
    await settle();
    expect(ended).toBe(true);
    expect(fake.refCount).toBe(0);
  });

  // Real Node v26: a child's stdout that nobody reads holds exactly its
  // 64 KiB highWaterMark (65536), whatever sizes the writes have.
  it("takes no more of a pipe than its high water mark, and gives the rest back in order", async () => {
    const { readFd, writeFd } = fake.processes.pipe();
    const output = new FdReadable(readFd);
    output.read(0);
    const sent: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const chunk = new Uint8Array(7000).fill(index);
      sent.push(...chunk);
      fake.fdStream.write(writeFd, chunk);
    }
    await settle();
    expect(output.readableLength).toBe(65536);
    expect(output.readableHighWaterMark).toBe(65536);
    const received: number[] = [];
    output.on("data", (chunk: Uint8Array) => received.push(...chunk));
    fake.fdStream.close(writeFd);
    await new Promise((resolve) => output.on("end", resolve));
    expect(received.length).toBe(70000);
    expect(received).toEqual(sent);
  });

  it("reads again after a chunk came while an unshift() had filled it", async () => {
    const { readFd, writeFd } = fake.processes.pipe();
    const output = new FdReadable(readFd);
    output.read(0);
    await settle();
    output.unshift(Buffer.alloc(65536, 1));
    fake.fdStream.write(writeFd, new Uint8Array(1000).fill(2));
    await settle();
    expect(output.readableLength).toBe(65536);
    let received = 0;
    output.on("data", (chunk: Uint8Array) => (received += chunk.length));
    fake.fdStream.close(writeFd);
    const ended = await Promise.race([
      new Promise((resolve) => output.on("end", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect([ended, received]).toEqual([true, 66536]);
  });

  it("delivers webnode Buffers", async () => {
    const stdin = new FdReadable(0);
    let first: unknown;
    stdin.once("data", (chunk: unknown) => {
      first = chunk;
    });
    fake.feedStdin("x");
    await settle();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(typeof (first as { toString(e: string): string }).toString("hex")).toBe("string");
    expect((first as { toString(e: string): string }).toString("hex")).toBe("78");
  });

  it("unref() and ref() drop and retake the process ref", async () => {
    const stdin = new FdReadable(0);
    stdin.on("data", () => {});
    await settle();
    expect(fake.refCount).toBe(1);
    expect(stdin.unref()).toBe(stdin);
    expect(fake.refCount).toBe(0);
    stdin.unref();
    expect(fake.refCount).toBe(0);
    stdin.ref();
    expect(fake.refCount).toBe(1);
    stdin.destroy();
    await settle();
    expect(fake.refCount).toBe(0);
  });

  it("an unref()'d stream never takes a ref", async () => {
    const stdin = new FdReadable(0).unref();
    const seen: string[] = [];
    stdin.on("data", (chunk: Uint8Array) => seen.push(Buffer.from(chunk).toString()));
    await settle();
    expect(fake.refCount).toBe(0);
    fake.feedStdin("hi");
    await settle();
    expect(seen).toEqual(["hi"]);
  });

  it("pause() stops reading and releases the ref; resume() restarts", async () => {
    const stdin = new FdReadable(0);
    const seen: string[] = [];
    stdin.on("data", (chunk: Uint8Array) => seen.push(Buffer.from(chunk).toString()));
    await settle();
    expect(fake.refCount).toBe(1);
    stdin.pause();
    await settle();
    expect(fake.refCount).toBe(0);
    fake.feedStdin("later");
    await settle();
    expect(seen).toEqual([]);
    stdin.resume();
    await settle();
    expect(fake.refCount).toBe(1);
    expect(seen).toEqual(["later"]);
  });

  it("reads a pipe and closes its fd at the end", async () => {
    const { readFd, writeFd } = fake.processes.pipe();
    const reader = new FdReadable(readFd);
    const writer = new FdWritable(writeFd);
    const seen: string[] = [];
    reader.on("data", (chunk: Uint8Array) => seen.push(Buffer.from(chunk).toString()));
    const closed = new Promise((resolve) => reader.on("close", resolve));
    writer.write("one ");
    writer.end("two");
    await closed;
    expect(seen.join("")).toBe("one two");
    expect(() => fake.fs.fstat(readFd)).toThrow(/EBADF/);
    expect(() => fake.fs.fstat(writeFd)).toThrow(/EBADF/);
    expect(fake.refCount).toBe(0);
  });

  // What child_process does with a child's output stream it gives to another
  // child as its stdio (Node: readStop on the handle, then pause).
  it("handOver() stops the reading for good: the pipe keeps what it was not handed, for whoever gets the fd", async () => {
    const { readFd, writeFd } = fake.processes.pipe();
    const reader = new FdReadable(readFd);
    const writer = new FdWritable(writeFd);
    reader.read(0);
    await settle();
    expect(fake.refCount).toBe(1);
    await new Promise<void>((resolve) => writer.write("kept ", () => resolve()));
    await settle();
    expect(reader.readableLength).toBe(5);
    reader.handOver();
    expect([reader.isPaused(), fake.refCount]).toEqual([true, 0]);
    await new Promise<void>((resolve) => writer.write("left in the pipe", () => resolve()));
    await settle();
    // What it already held is its own; the rest was never taken.
    expect(reader.readableLength).toBe(5);
    expect(Buffer.from(fake.fs.read(readFd, 100, null)).toString()).toBe("left in the pipe");
    // The stream can still be read: its own choice, as in Node.
    await new Promise<void>((resolve) => writer.write("more", () => resolve()));
    const seen: string[] = [];
    reader.on("data", (chunk: Uint8Array) => seen.push(Buffer.from(chunk).toString()));
    reader.resume();
    await settle();
    expect(seen.join("")).toBe("kept more");
    reader.destroy();
    writer.destroy();
  });

  it("autoClose: false leaves the fd open", async () => {
    const { readFd, writeFd } = fake.processes.pipe();
    const reader = new FdReadable(readFd, { autoClose: false });
    reader.resume();
    fake.fdStream.close(writeFd);
    await new Promise((resolve) => reader.on("close", resolve));
    expect(fake.fs.fstat(readFd)).toBeDefined();
  });
});

describe("FdWritable", () => {
  it("writes to stdout in order and never holds a ref", async () => {
    const stdout = new FdWritable(1);
    expect(stdout.fd).toBe(1);
    stdout.write("a");
    stdout.write(Buffer.from("b"));
    stdout.write(new Uint8Array([99]));
    expect(fake.refCount).toBe(0);
    await new Promise<void>((resolve) => stdout.end("d", () => resolve()));
    expect(fake.stdout()).toBe("abcd");
    // fd 1 stays open after end().
    expect(fake.fs.fstat(1)).toBeDefined();
  });

  it("encodes strings with the given encoding", async () => {
    const stdout = new FdWritable(1);
    await new Promise<void>((resolve) => stdout.write("aGk=", "base64", () => resolve()));
    expect(fake.stdout()).toBe("hi");
  });

  it("reports a write error through the stream", async () => {
    const stdout = new FdWritable(1);
    fake.fdStream.close(1);
    const error = await new Promise<Error>((resolve) => {
      stdout.on("error", resolve);
      stdout.write("x");
    });
    expect((error as { code?: string }).code).toBe("EBADF");
  });

  // Real Node v26, a write to a pipe whose reader has gone:
  // { message: 'write EPIPE', errno: -32, code: 'EPIPE', syscall: 'write' }.
  it("words a failed write as Node's streams do: `write EPIPE`, not the fs form", async () => {
    const { readFd, writeFd } = fake.processes.pipe();
    fake.fdStream.close(readFd);
    const writer = new FdWritable(writeFd);
    writer.on("error", () => {});
    const error = await new Promise<Error | null | undefined>((resolve) =>
      writer.write("x", resolve),
    );
    expect({ ...error, message: error?.message }).toEqual({
      message: "write EPIPE",
      errno: -32,
      code: "EPIPE",
      syscall: "write",
    });
    expect(Object.keys(error ?? {})).toEqual(["errno", "code", "syscall"]);
  });
});

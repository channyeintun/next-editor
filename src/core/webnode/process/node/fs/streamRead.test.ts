// @vitest-environment node
// The asynchronous reads of a pipe or terminal (`readFile(0, cb)`, `readv`,
// `FileHandle.readFile` / `readv`) wait for bytes without blocking the
// process: its timers keep running until the writer ends, as under Node.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import { Buffer } from "../buffer";
import fs from "../fs";
import { FileHandle } from "./promises";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

/** Feeds stdin in two parts, a few timer turns apart, then closes it; counts timer turns meanwhile. */
function feedSlowly(): { ticks: () => number } {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  setTimeout(() => fake.feedStdin("hello "), 15);
  setTimeout(() => {
    fake.feedStdin("world");
    fake.feedStdin(null);
    clearInterval(timer);
  }, 30);
  return { ticks: () => ticks };
}

describe("reading a pipe without blocking", () => {
  it("fs.readFile(0) waits for the end of the pipe", async () => {
    const feed = feedSlowly();
    const [error, text] = await new Promise<unknown[]>((resolve) =>
      fs.readFile(0, "utf8", (...args: unknown[]) => resolve(args)),
    );
    expect([error, text]).toEqual([null, "hello world"]);
    expect(feed.ticks()).toBeGreaterThan(3);
  });

  it("fs.readv(0) waits for bytes and spreads them over the buffers", async () => {
    setTimeout(() => fake.feedStdin("abcdef"), 10);
    const a = Buffer.alloc(4);
    const b = Buffer.alloc(4);
    const [error, bytesRead] = await new Promise<unknown[]>((resolve) =>
      fs.readv(0, [a, b], (...args: unknown[]) => resolve(args)),
    );
    expect([error, bytesRead, a.toString(), b.toString("latin1", 0, 2)]).toEqual([
      null,
      6,
      "abcd",
      "ef",
    ]);
  });

  it("FileHandle.readFile and readv wait for the pipe", async () => {
    const handle = new FileHandle(0);
    setTimeout(() => fake.feedStdin("xy"), 10);
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.readv([buffer]);
    expect(buffer.toString("latin1", 0, bytesRead)).toBe("xy");
    const feed = feedSlowly();
    expect(await handle.readFile("utf8")).toBe("hello world");
    expect(feed.ticks()).toBeGreaterThan(3);
  });

  it("a regular file is still read in one go", async () => {
    fake.vfs.writeFile("/f", new TextEncoder().encode("data"), 0o1101, 0o644);
    const fd = fs.openSync("/f", "r");
    const text = await new Promise<unknown>((resolve) =>
      fs.readFile(fd, "utf8", (_error: unknown, value: unknown) => resolve(value)),
    );
    expect(text).toBe("data");
    fs.closeSync(fd);
  });
});

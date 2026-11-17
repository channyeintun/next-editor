// @vitest-environment node
// Liveness for the browser's own streaming work: iterating or piping a
// ReadableStream and an open WebSocket hold a ref until they finish.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { createRefedWebSocket, keepAliveWhileStreaming } from "./globals";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

/** A ReadableStream class of its own, so the patch does not touch the global one. */
class TestStream<T> extends ReadableStream<T> {}
keepAliveWhileStreaming(TestStream.prototype as ReadableStream);

function controlled(): {
  stream: TestStream<string>;
  controller: ReadableStreamDefaultController<string>;
} {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new TestStream<string>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("ReadableStream", () => {
  it("holds a ref while for-await waits for the next chunk", async () => {
    const { stream, controller } = controlled();
    const seen: string[] = [];
    const done = (async () => {
      for await (const chunk of stream) {
        seen.push(chunk);
      }
    })();
    await turn();
    expect(fake.refCount).toBe(1);
    controller.enqueue("a");
    await turn();
    expect(seen).toEqual(["a"]);
    expect(fake.refCount).toBe(1);
    controller.close();
    await done;
    expect(fake.refCount).toBe(0);
  });

  it("holds a ref until pipeTo finishes", async () => {
    const { stream, controller } = controlled();
    const written: string[] = [];
    const piped = stream.pipeTo(new WritableStream({ write: (chunk) => void written.push(chunk) }));
    await turn();
    expect(fake.refCount).toBe(1);
    controller.enqueue("x");
    controller.close();
    await piped;
    expect(written).toEqual(["x"]);
    expect(fake.refCount).toBe(0);
  });

  it("holds a ref until pipeThrough's source is drained", async () => {
    const { stream, controller } = controlled();
    const upper = stream.pipeThrough(
      new TransformStream<string, string>({
        transform: (chunk, c) => c.enqueue(chunk.toUpperCase()),
      }),
    );
    await turn();
    expect(fake.refCount).toBe(1);
    controller.enqueue("y");
    controller.close();
    const reader = upper.getReader();
    expect((await reader.read()).value).toBe("Y");
    expect((await reader.read()).done).toBe(true);
    await turn();
    expect(fake.refCount).toBe(0);
  });

  it("throws as the spec says when pipeThrough's source is locked", () => {
    const { stream } = controlled();
    stream.getReader();
    expect(() => stream.pipeThrough(new TransformStream())).toThrow(TypeError);
    expect(fake.refCount).toBe(0);
  });
});

describe("WebSocket", () => {
  class FakeSocket extends EventTarget {
    readonly url: string;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
    }
  }
  const RefedSocket = createRefedWebSocket(FakeSocket as unknown as typeof WebSocket);

  it("keeps the process alive from construction until close", () => {
    // A remote host: a local one is served inside the runtime (http/localWebSocket.ts).
    const socket = new RefedSocket("ws://example.com/");
    expect(socket).toBeInstanceOf(FakeSocket);
    expect(fake.refCount).toBe(1);
    socket.dispatchEvent(new Event("open"));
    expect(fake.refCount).toBe(1);
    socket.dispatchEvent(new Event("error"));
    socket.dispatchEvent(new Event("close"));
    socket.dispatchEvent(new Event("close"));
    expect(fake.refCount).toBe(0);
  });
});

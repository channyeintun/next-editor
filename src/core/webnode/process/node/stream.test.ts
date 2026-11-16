// @vitest-environment node
// The `stream`, `stream/promises`, `stream/web` and `stream/consumers` builtins.
import { describe, expect, it } from "vitest";
import { Buffer } from "./buffer";
import stream, { Duplex, PassThrough, Readable, Transform, Writable } from "./stream";
import type { Readable as ReadableType, Stream as StreamType } from "./stream";
import consumers from "./stream_consumers";
import streamPromises from "./stream_promises";
import streamWeb from "./stream_web";

function collect(readable: ReadableType): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    readable.on("data", (chunk) => chunks.push(chunk));
    readable.on("end", () => resolve(chunks));
    readable.on("error", reject);
  });
}

/** `Object.keys(require("stream"))` in Node 22. */
const NODE_22_EXPORTS = [
  "isDestroyed",
  "isDisturbed",
  "isErrored",
  "isReadable",
  "isWritable",
  "Readable",
  "Writable",
  "Duplex",
  "Transform",
  "PassThrough",
  "duplexPair",
  "pipeline",
  "addAbortSignal",
  "finished",
  "destroy",
  "compose",
  "setDefaultHighWaterMark",
  "getDefaultHighWaterMark",
  "promises",
  "Stream",
  "_isArrayBufferView",
  "_isUint8Array",
  "_uint8ArrayToBuffer",
];

function text(chunks: unknown[]): string {
  return chunks.map((chunk) => Buffer.from(chunk as Uint8Array).toString()).join("");
}

describe("stream: module shape", () => {
  it("has every export Node 22 has", () => {
    expect(NODE_22_EXPORTS.filter((name) => !(name in stream))).toEqual([]);
    for (const name of ["fromWeb", "toWeb", "from"]) {
      expect(typeof (Readable as unknown as Record<string, unknown>)[name], `${name}`).toBe(
        "function",
      );
      expect(typeof (Duplex as unknown as Record<string, unknown>)[name], `${name}`).toBe(
        "function",
      );
    }
    expect(typeof Writable.fromWeb).toBe("function");
    expect(typeof Writable.toWeb).toBe("function");
    expect(stream.Stream).toBe(stream);
    expect(stream.promises).toBe(streamPromises);
    expect(stream._isArrayBufferView(new DataView(new ArrayBuffer(1)))).toBe(true);
    expect(stream._isUint8Array(new Uint8Array(1))).toBe(true);
    expect(Buffer.isBuffer(stream._uint8ArrayToBuffer(new Uint8Array([1])))).toBe(true);
  });

  it("the default export is the legacy, util.inherits-friendly Stream", () => {
    function Legacy(this: StreamType) {
      stream.call(this);
    }
    // What util.inherits does.
    Object.setPrototypeOf(Legacy.prototype, stream.prototype);
    Object.setPrototypeOf(Legacy, stream);
    const instance = new (Legacy as unknown as new () => StreamType)();
    expect(instance).toBeInstanceOf(stream);
    expect(typeof instance.pipe).toBe("function");
    expect(new Readable()).toBeInstanceOf(stream);
  });

  it("high water marks", () => {
    expect(stream.getDefaultHighWaterMark(false)).toBe(65536);
    expect(new Readable().readableHighWaterMark).toBe(65536);
    expect(stream.getDefaultHighWaterMark(true)).toBe(16);
  });
});

describe("stream: behaviour", () => {
  it("Readable.from and async iteration", async () => {
    const readable = Readable.from(["a", "b", "c"]);
    const seen: unknown[] = [];
    for await (const chunk of readable) {
      seen.push(chunk);
    }
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("pipeline through a Transform", async () => {
    const upper = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk.toString().toUpperCase());
      },
    });
    const out: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        out.push(chunk.toString());
        callback();
      },
    });
    await streamPromises.pipeline(Readable.from(["ab", "cd"]), upper, sink);
    expect(out.join("")).toBe("ABCD");
  });

  it("callback pipeline reports errors and destroys every stream", async () => {
    const source = new Readable({ read() {} });
    const middle = new PassThrough();
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("sink failed"));
      },
    });
    const error = await new Promise<Error | null | undefined>((resolve) => {
      stream.pipeline(source, middle, sink, resolve);
      source.push("x");
    });
    expect(error?.message).toBe("sink failed");
    expect(source.destroyed).toBe(true);
    expect(middle.destroyed).toBe(true);
  });

  it("objectMode", async () => {
    const readable = new Readable({ objectMode: true, read() {} });
    readable.push({ a: 1 });
    readable.push([2]);
    readable.push(null);
    expect(await collect(readable)).toEqual([{ a: 1 }, [2]]);
  });

  it("backpressure: write returns false past the high water mark, then drains", async () => {
    let release: () => void = () => {};
    const writable = new Writable({
      highWaterMark: 4,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    expect(writable.write("ab")).toBe(true);
    expect(writable.write("cdef")).toBe(false);
    const drained = new Promise((resolve) => writable.once("drain", resolve));
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await drained;
    expect(writable.writableLength).toBe(0);
  });

  it("finished and destroy with an error", async () => {
    const readable = new Readable({ read() {} });
    const done = new Promise<Error | null | undefined>((resolve) =>
      stream.finished(readable, resolve),
    );
    stream.destroy(readable, new Error("boom"));
    expect((await done)?.message).toBe("boom");
    expect(stream.isDestroyed(readable)).toBe(true);
    expect(stream.isErrored(readable)).toBe(true);
    await expect(
      streamPromises.finished(new PassThrough().end().resume()),
    ).resolves.toBeUndefined();
  });

  it("compose", async () => {
    const double = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk.toString() + chunk.toString());
      },
    });
    const composed = stream.compose(double, async function* (source: AsyncIterable<unknown>) {
      for await (const chunk of source) {
        yield String(chunk).toUpperCase();
      }
    });
    composed.end("ab");
    expect(text(await collect(composed))).toBe("ABAB");
  });

  it("Uint8Array chunks become Buffers", async () => {
    const readable = new Readable({ read() {} });
    readable.push(new Uint8Array([104, 105]));
    readable.push(null);
    const [chunk] = await collect(readable);
    expect(chunk instanceof Uint8Array).toBe(true);
    expect((chunk as Buffer).toString()).toBe("hi");
  });

  it("duplexPair connects two sides", async () => {
    const [left, right] = stream.duplexPair();
    const received = collect(right);
    left.end("ping");
    right.end();
    expect(text(await received)).toBe("ping");
  });
});

describe("stream: web adapters", () => {
  it("Readable.fromWeb", async () => {
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("he"));
        controller.enqueue(new TextEncoder().encode("llo"));
        controller.close();
      },
    });
    expect(text(await collect(Readable.fromWeb(web as never)))).toBe("hello");
    const encoded = Readable.fromWeb(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
          controller.close();
        },
      }) as never,
      { encoding: "utf8" },
    );
    expect(await collect(encoded)).toEqual(["x"]);
    expect(() => Readable.fromWeb({} as never)).toThrow(/ReadableStream/);
  });

  it("Readable.fromWeb carries errors and cancels on destroy", async () => {
    const failing = Readable.fromWeb(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("web failed"));
        },
      }) as never,
    );
    await expect(collect(failing)).rejects.toThrow("web failed");
    let cancelled: unknown = null;
    const cancellable = Readable.fromWeb(
      new ReadableStream({
        cancel(reason) {
          cancelled = reason;
        },
      }) as never,
    );
    cancellable.on("error", () => {});
    cancellable.destroy(new Error("stop"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((cancelled as Error).message).toBe("stop");
  });

  it("Readable.toWeb round trip", async () => {
    const web = Readable.toWeb(Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
    expect(await consumers.text(web as ReadableStream)).toBe("abcd");
    const objects = Readable.toWeb(Readable.from([{ a: 1 }, { b: 2 }]));
    const reader = (objects as ReadableStream).getReader();
    expect((await reader.read()).value).toEqual({ a: 1 });
    expect((await reader.read()).value).toEqual({ b: 2 });
    expect((await reader.read()).done).toBe(true);
    const back = Readable.fromWeb(Readable.toWeb(Readable.from(["x", "y"])));
    expect(text(await collect(back))).toBe("xy");
  });

  it("Writable.fromWeb", async () => {
    const written: string[] = [];
    let closed = false;
    const web = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(new TextDecoder().decode(chunk));
      },
      close() {
        closed = true;
      },
    });
    const writable = Writable.fromWeb(web as never);
    writable.write("hé");
    writable.write(Buffer.from("llo"));
    writable.write("6869", "hex");
    await new Promise<void>((resolve, reject) => {
      writable.end(() => resolve());
      writable.on("error", reject);
    });
    expect(written.join("")).toBe("héllohi");
    expect(closed).toBe(true);
  });

  it("Writable.toWeb with backpressure", async () => {
    const chunks: string[] = [];
    const slow = new Writable({
      highWaterMark: 2,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        setTimeout(callback, 1);
      },
    });
    const web = Writable.toWeb(slow) as WritableStream;
    const writer = web.getWriter();
    for (const part of ["a", "bb", "ccc"]) {
      await writer.ready;
      await writer.write(new TextEncoder().encode(part));
    }
    await writer.close();
    expect(chunks.join("")).toBe("abbccc");
    expect(slow.writableFinished).toBe(true);
  });

  it("Duplex.fromWeb and Duplex.toWeb", async () => {
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase()));
      },
    });
    const duplex = Duplex.fromWeb(transform as never);
    const out = collect(duplex);
    duplex.end("shout");
    expect(text(await out)).toBe("SHOUT");

    const pass = new PassThrough();
    const pair = Duplex.toWeb(pass) as { readable: ReadableStream; writable: WritableStream };
    const writer = pair.writable.getWriter();
    void writer.write(new TextEncoder().encode("echo"));
    void writer.close();
    expect(await consumers.text(pair.readable)).toBe("echo");
  });

  it("Duplex.from accepts web streams", async () => {
    const readable = Duplex.from(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("z"));
          controller.close();
        },
      }) as never,
    );
    expect(text(await collect(readable))).toBe("z");
  });
});

describe("stream/web and stream/consumers", () => {
  it("stream/web reads the globals", () => {
    expect(streamWeb.ReadableStream).toBe(globalThis.ReadableStream);
    expect(streamWeb.TransformStream).toBe(globalThis.TransformStream);
    expect(streamWeb.CompressionStream).toBe(globalThis.CompressionStream);
    expect(streamWeb.TextDecoderStream).toBe(globalThis.TextDecoderStream);
    expect(Object.keys(streamWeb)).toContain("ReadableStreamBYOBReader");
  });

  it("consumers read Node streams, web streams and async iterables", async () => {
    expect(await consumers.text(Readable.from([Buffer.from("h"), Buffer.from("i")]))).toBe("hi");
    expect(await consumers.json(Readable.from(['{"a"', ":1}"]))).toEqual({ a: 1 });
    const buffer = await consumers.buffer(Readable.from([Buffer.from([1, 2]), Buffer.from([3])]));
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(Array.from(buffer)).toEqual([1, 2, 3]);
    const arrayBuffer = await consumers.arrayBuffer(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([9]));
          controller.close();
        },
      }),
    );
    expect(Array.from(new Uint8Array(arrayBuffer))).toEqual([9]);
    async function* generate() {
      yield new TextEncoder().encode("é".slice(0, 1)).subarray(0, 1);
      yield new TextEncoder().encode("é").subarray(1);
    }
    expect(await consumers.text(generate())).toBe("é");
    const blob = await consumers.blob(Readable.from([Buffer.from("blob")]));
    expect(await blob.text()).toBe("blob");
    expect(Array.from(await consumers.bytes(Readable.from([Buffer.from([7])])))).toEqual([7]);
  });
});

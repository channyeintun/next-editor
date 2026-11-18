// @vitest-environment node
// The `stream`, `stream/promises`, `stream/web` and `stream/consumers` builtins.
import type { Duplex as NodeDuplex, Writable as NodeWritable } from "node:stream";
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

  // Real Node v26 and v22: a byte stream takes any view, as a Buffer over
  // the same memory; another chunk is refused in Node's words.
  it("takes any TypedArray or DataView as a byte chunk, and refuses others as Node does", async () => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk: unknown, _encoding: string, callback: () => void) {
        written.push(`${Buffer.isBuffer(chunk)} ${(chunk as Buffer).length}`);
        callback();
      },
    });
    sink.write(new Float32Array(2));
    sink.end(new DataView(new ArrayBuffer(3)));
    const through = new PassThrough();
    through.write(new Uint16Array([1]));
    through.end();
    const readable = new Readable({ read() {} });
    readable.push(new Int32Array(1));
    readable.unshift(new Float64Array(1));
    readable.push(null);
    const objects = new Readable({ objectMode: true, read() {} });
    const view = new Float32Array(1);
    objects.push(view);
    expect(written).toEqual(["true 8", "true 3"]);
    expect((await collect(through)).map((chunk) => (chunk as Buffer).length)).toEqual([2]);
    expect((await collect(readable)).map((chunk) => (chunk as Buffer).length)).toEqual([8, 4]);
    expect(objects.read()).toBe(view);
    expect([Readable.prototype.push.length, Readable.prototype.unshift.length]).toEqual([2, 2]);
    expect(() => sink.write(1)).toThrow(
      'The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received type number (1)',
    );
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

describe("stream: read() with no size", () => {
  // What real Node v26 prints for the same reads (Node 26 takes the first
  // buffered chunk of a byte stream without an encoding).
  it("takes the first buffered chunk, as Node 26 does", async () => {
    const seen: unknown[] = [];
    const readable = new Readable({ read() {} });
    readable.push("a");
    readable.push("b");
    readable.push("cc");
    seen.push(String(readable.read()), String(readable.read()), readable.readableLength);
    // An ended stream that read() empties ends.
    const ending = new Readable({ read() {} });
    const ended = new Promise((resolve) => ending.on("end", resolve));
    ending.push("x");
    ending.push(null);
    seen.push(String(ending.read()));
    // A chunk past the high water mark comes whole, and the mark stays.
    const big = new Readable({ read() {}, highWaterMark: 4 });
    big.push("123456");
    big.push("78");
    seen.push(String(big.read()), big.readableHighWaterMark);
    // With an encoding the buffered text comes together.
    const text = new Readable({ read() {} });
    text.setEncoding("utf8");
    text.push("a");
    text.push("b");
    seen.push(String(text.read()));
    expect(seen).toEqual(["a", "b", 2, "x", "123456", 4, "ab"]);
    await ended;
  });

  it("lets for await yield each chunk", async () => {
    const readable = new Readable({ read() {} });
    for (const chunk of ["c0", "c1", "c2"]) {
      readable.push(chunk);
    }
    readable.push(null);
    const chunks: string[] = [];
    for await (const chunk of readable) {
      chunks.push(String(chunk));
    }
    expect(chunks).toEqual(["c0", "c1", "c2"]);
  });
});

// What real Node v26 logs for each scenario (v22 differs in most: it joins the
// buffered chunks, and emits a second 'readable' after an end nobody saw).
describe("stream: paused reads as Node 26 does them", () => {
  type Log = (...parts: string[]) => void;
  const show = (chunk: unknown): string =>
    chunk === null
      ? "null"
      : chunk instanceof Uint8Array
        ? `B(${new TextDecoder().decode(chunk)})`
        : `${typeof chunk}(${String(chunk)})`;
  /** Lets `count` turns of the event loop pass: every tick and promise job queued by then has run. */
  const turns = async (count = 3): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const source = () => new Readable({ read() {} });
  /** A 'readable' listener that reads until `read()` returns null. */
  const drainOnReadable = (readable: ReadableType, log: Log) => {
    readable.on("readable", () => {
      log("readable");
      for (let chunk = readable.read(); chunk !== null; chunk = readable.read()) {
        log(show(chunk));
      }
    });
    readable.on("end", () => log("end"));
  };

  const scenarios: [string, (log: Log) => Promise<void> | void, string][] = [
    [
      "read(null), read(NaN) and a size that is no number mean no size",
      (log) => {
        for (const size of [null, NaN, "x", {}]) {
          const r = source();
          r.push("a");
          r.push("b");
          log(show(r.read(size as never)), show(r.read(size as never)));
        }
      },
      "B(a) B(b) B(a) B(b) B(a) B(b) B(a) B(b)",
    ],
    [
      "a size is parsed as an integer",
      (log) => {
        const r = source();
        r.push("abc");
        log(show(r.read("1" as never)), show(r.read("1.9" as never)), show(r.read(1.5)));
        const zero = source();
        zero.push("a");
        zero.push("b");
        log(show(zero.read(0)), show(zero.read(-1)), show(zero.read()));
      },
      "B(a) B(b) B(c) null null B(a)",
    ],
    [
      "_read gets the stream's own mark when a buffered chunk is larger",
      (log) => {
        const sizes: string[] = [];
        const r = new Readable({
          highWaterMark: 4,
          read(size) {
            sizes.push(`${size}/${this.readableHighWaterMark}`);
          },
        });
        r.push("abcdefghijklmnop");
        r.push("q");
        log(show(r.read()), show(r.read()), sizes.join(","), String(r.readableHighWaterMark));
      },
      "B(abcdefghijklmnop) B(q) 4/4 4",
    ],
    [
      "an explicit size above the mark raises it",
      (log) => {
        const sizes: number[] = [];
        const r = new Readable({
          highWaterMark: 4,
          read(size) {
            sizes.push(size);
          },
        });
        r.push("abcdefghijklmnop");
        r.push("q");
        log(show(r.read(16)), sizes.join(","), String(r.readableHighWaterMark));
      },
      "B(abcdefghijklmnop) 16 16",
    ],
    [
      "_read is called once what stays buffered is below the mark",
      (log) => {
        const sizes: number[] = [];
        const r = new Readable({
          highWaterMark: 4,
          read(size) {
            sizes.push(size);
          },
        });
        r.push("ab");
        r.push("cdefgh");
        r.push("i");
        log(show(r.read()), `[${sizes}]`, show(r.read()), `[${sizes}]`, show(r.read()));
        log(`[${sizes}]`);
      },
      "B(ab) [] B(cdefgh) [4] B(i) [4]",
    ],
    [
      "chunks _read pushes at once come one by one",
      (log) => {
        let calls = 0;
        const r = new Readable({
          read() {
            if (calls++ === 0) {
              this.push("a");
              this.push("b");
              this.push("c");
            }
          },
        });
        log(show(r.read()), show(r.read()), show(r.read()), show(r.read()));
      },
      "B(a) B(b) B(c) null",
    ],
    [
      "chunks and the end _read pushes at once",
      async (log) => {
        const r = new Readable({
          read() {
            this.push("a");
            this.push("b");
            this.push(null);
          },
        });
        r.on("end", () => log("end"));
        log(show(r.read()), show(r.read()), show(r.read()));
        await turns();
      },
      "B(a) B(b) null end",
    ],
    [
      "chunks _read pushes behind a buffered one",
      (log) => {
        let calls = 0;
        const r = new Readable({
          highWaterMark: 8,
          read() {
            if (calls++ < 2) {
              this.push(`x${calls}`);
            }
          },
        });
        r.push("a");
        log(show(r.read()), show(r.read()), show(r.read()), show(r.read()));
      },
      "B(a) B(x1) B(x2) null",
    ],
    [
      "a chunk _read puts back in front",
      (log) => {
        let calls = 0;
        const r = new Readable({
          read() {
            if (calls++ === 0) {
              this.unshift(Buffer.from("UU"));
            }
          },
        });
        r.push("a");
        r.push("b");
        log(show(r.read()), show(r.read()), show(r.read()), show(r.read()));
      },
      "B(U) B(U) B(a) B(b)",
    ],
    [
      "a _read that throws",
      async (log) => {
        const r = new Readable({
          read() {
            throw new Error("bad read");
          },
        });
        r.on("error", (error) => log(`error ${error.message}`));
        r.push("a");
        log(show(r.read()), `destroyed ${r.destroyed}`);
        await turns();
      },
      "B(a) destroyed true error bad read",
    ],
    [
      "a _read that throws on a stream that does not destroy itself",
      async (log) => {
        const r = new Readable({
          autoDestroy: false,
          read() {
            throw new Error("bad read");
          },
        });
        r.on("error", (error) => log(`error ${error.message}`));
        r.push("a");
        log(show(r.read()), `destroyed ${r.destroyed}`, `errored ${r.errored?.message}`);
        await turns();
      },
      "error bad read B(a) destroyed false errored bad read",
    ],
    [
      "_read and 'data' listeners see a paused stream",
      (log) => {
        const r = new Readable({
          read() {
            log(`_read ${this.readableFlowing} ${this.isPaused()}`);
          },
        });
        r.pause();
        r.on("data", (chunk) => log(`data ${show(chunk)} ${r.readableFlowing} ${r.isPaused()}`));
        r.push("a");
        r.push("b");
        log(show(r.read()), `after ${r.readableFlowing} ${r.isPaused()}`);
      },
      "_read false true data B(a) false true B(a) after false true",
    ],
    [
      "a 'data' listener that resumes a paused stream",
      async (log) => {
        const r = source();
        r.pause();
        const seen: string[] = [];
        r.on("data", (chunk) => {
          seen.push(String(chunk));
          r.resume();
        });
        r.push("a");
        r.push("b");
        r.push("c");
        log(show(r.read()), `${r.readableFlowing} ${r.isPaused()}`);
        await turns();
        log(seen.join(""));
      },
      "B(a) true false abc",
    ],
    [
      "a 'data' listener under a 'readable' listener",
      async (log) => {
        const r = source();
        r.on("readable", () => {});
        const seen: string[] = [];
        r.on("data", (chunk) => {
          seen.push(String(chunk));
          r.resume();
        });
        r.push("a");
        r.push("b");
        log(show(r.read()), `${r.readableFlowing} ${r.isPaused()}`);
        await turns();
        log(seen.join(""));
      },
      "B(a) false true a",
    ],
    [
      "one read per 'readable'",
      async (log) => {
        const r = source();
        r.push("a");
        r.push("b");
        r.push("c");
        r.on("readable", () => log(`readable:${show(r.read())}`));
        await turns();
        log(`left ${r.readableLength}`);
      },
      "readable:B(a) left 2",
    ],
    [
      "one read per 'readable' on a stream that ended unobserved",
      async (log) => {
        const r = source();
        r.push("a");
        r.push("b");
        r.push(null);
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
        log(`left ${r.readableLength} ended ${r.readableEnded}`);
      },
      "readable:B(a) left 1 ended false",
    ],
    [
      "a read loop on a stream that ended unobserved",
      async (log) => {
        const r = source();
        r.push("a");
        r.push("b");
        r.push(null);
        drainOnReadable(r, log);
        await turns();
      },
      "readable B(a) B(b) end",
    ],
    [
      "a listener added after an end with nothing buffered",
      async (log) => {
        const r = source();
        r.push(null);
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "readable:null end",
    ],
    [
      "a listener added a tick after an end with nothing buffered",
      async (log) => {
        const r = source();
        r.push(null);
        await new Promise<void>((resolve) => process.nextTick(resolve));
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "readable:null end",
    ],
    [
      "a listener added turns after an end with data",
      async (log) => {
        const r = source();
        r.push("a");
        r.push("b");
        r.push(null);
        await turns();
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
        log(`left ${r.readableLength}`);
      },
      "readable:B(a) left 1",
    ],
    [
      "a listener added before the chunks and the end",
      async (log) => {
        const r = source();
        drainOnReadable(r, log);
        r.push("a");
        r.push("b");
        r.push(null);
        await turns();
      },
      "readable B(a) B(b) end",
    ],
    [
      "an end pushed later, with a listener",
      async (log) => {
        const r = source();
        drainOnReadable(r, log);
        r.push("a");
        setImmediate(() => r.push(null));
        await turns();
      },
      "readable B(a) readable end",
    ],
    [
      "an end pushed later, read afterwards",
      async (log) => {
        const r = source();
        r.push("a");
        r.on("end", () => log("end"));
        setImmediate(() => r.push(null));
        await turns();
        log(show(r.read()), show(r.read()));
        await turns();
      },
      "B(a) null end",
    ],
    [
      "a stream that ended unobserved, then flows",
      async (log) => {
        const r = source();
        r.push("a");
        r.push("b");
        r.push(null);
        await turns();
        r.on("data", (chunk) => log(`data:${String(chunk)}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "data:a data:b end",
    ],
    [
      "an empty stream that ended unobserved",
      async (log) => {
        const resumed = source();
        resumed.push(null);
        resumed.on("end", () => log("end"));
        resumed.resume();
        await turns();
        const untouched = source();
        untouched.push(null);
        untouched.on("end", () => log("end"));
        await turns();
        log(`ended ${untouched.readableEnded}`);
      },
      "end ended false",
    ],
    [
      "once('readable') after an unobserved end",
      async (log) => {
        const r = source();
        r.push("a");
        r.push(null);
        r.once("readable", () => log(`readable:${show(r.read())}:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "readable:B(a):null end",
    ],
    [
      "for await over a stream that ended unobserved",
      async (log) => {
        const r = source();
        r.push("a");
        r.push("b");
        r.push(null);
        for await (const chunk of r) {
          log(show(chunk));
        }
        const empty = source();
        empty.push(null);
        for await (const chunk of empty) {
          log(show(chunk));
        }
        log("done");
      },
      "B(a) B(b) done",
    ],
    [
      "a PassThrough that ended unobserved",
      async (log) => {
        const later = new PassThrough();
        later.write("a");
        later.write("b");
        later.end();
        await turns();
        drainOnReadable(later, log);
        await turns();
        const sameTurn = new PassThrough();
        sameTurn.end("c");
        drainOnReadable(sameTurn, log);
        await turns();
      },
      "readable B(a) B(b) end readable B(c) end",
    ],
    [
      "an object stream that ended unobserved",
      async (log) => {
        const r = new Readable({ objectMode: true, read() {} });
        r.push(1);
        r.push(2);
        r.push(null);
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
        log(`left ${r.readableLength}`);
      },
      "readable:number(1) left 1",
    ],
    [
      "a stream with an encoding that ended unobserved",
      async (log) => {
        const r = source();
        r.setEncoding("utf8");
        r.push("a");
        r.push("b");
        r.push(null);
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "readable:string(ab) end",
    ],
    [
      "an end pushed by _read, at once and later",
      async (log) => {
        const atOnce = new Readable({
          read() {
            this.push("a");
            this.push(null);
          },
        });
        drainOnReadable(atOnce, log);
        await turns();
        let calls = 0;
        const later = new Readable({
          read() {
            setImmediate(() => this.push(calls++ < 2 ? `c${calls}` : null));
          },
        });
        drainOnReadable(later, log);
        await turns(6);
      },
      "readable B(a) end readable B(c1) readable B(c2) readable end",
    ],
    [
      "a 'readable' listener removed again after an unobserved end",
      async (log) => {
        const r = source();
        r.push("a");
        r.push(null);
        const listener = () => log("readable");
        r.on("readable", listener);
        r.off("readable", listener);
        r.on("data", (chunk) => log(`data:${String(chunk)}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "data:a end",
    ],
    [
      "a pipe from a stream that ended unobserved",
      async (log) => {
        const r = source();
        r.push("a");
        r.push("b");
        r.push(null);
        const through = new PassThrough();
        r.pipe(through);
        const got: string[] = [];
        through.on("data", (chunk) => got.push(String(chunk)));
        through.on("end", () => log(`end ${got.join("|")}`));
        await turns();
      },
      "end a|b",
    ],
    [
      "read(0) and a chunk put back after an unobserved end",
      async (log) => {
        const nudged = source();
        nudged.push("a");
        nudged.push(null);
        nudged.on("end", () => log("end"));
        log(show(nudged.read(0)), show(nudged.read()), show(nudged.read()));
        await turns();
        const r = source();
        r.push("b");
        r.push(null);
        r.unshift(r.read());
        drainOnReadable(r, log);
        await turns();
      },
      "null B(a) null end readable B(b) end",
    ],
    [
      "a listener added after the reads that emptied a stream ended unobserved",
      async (log) => {
        const r = source();
        r.push("a");
        r.push(null);
        log(show(r.read()));
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "B(a) end",
    ],
    [
      "a listener added after read(0) of an empty stream ended unobserved",
      async (log) => {
        const r = source();
        r.push(null);
        log(show(r.read(0)));
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "null end",
    ],
    [
      "an end put in front (unshift(null)) while nobody observes",
      async (log) => {
        const r = source();
        r.push("a");
        r.unshift(null);
        drainOnReadable(r, log);
        await turns();
      },
      "readable B(a) end",
    ],
    [
      "two listeners added after an unobserved end, the first with addListener",
      async (log) => {
        const r = source();
        r.push(null);
        r.addListener("readable", () => log("first"));
        r.on("readable", () => log("second"));
        r.on("end", () => log("end"));
        await turns();
      },
      "first second end",
    ],
    [
      "a stream destroyed before its listener's event",
      async (log) => {
        const r = source();
        r.push(null);
        r.on("readable", () => log("readable"));
        r.on("close", () => log("close"));
        r.destroy();
        await turns();
      },
      "close",
    ],
    [
      "a listener added after the reads emptied a stream that does not destroy itself",
      async (log) => {
        const r = new Readable({ autoDestroy: false, read() {} });
        r.push("a");
        r.push(null);
        log(show(r.read()));
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "B(a) end",
    ],
    [
      "a chunk put back after a read that found the end",
      async (log) => {
        const r = new Readable({
          read() {
            this.push(null);
          },
        });
        log(show(r.read()));
        r.unshift(Buffer.from("x"));
        drainOnReadable(r, log);
        await turns();
      },
      "null readable B(x) end",
    ],
    [
      "a listener that is refused, then a real one a tick later, after an unobserved end",
      async (log) => {
        const r = source();
        r.push(null);
        try {
          r.on("readable", 5 as never);
        } catch (error) {
          log((error as { code: string }).code);
        }
        await new Promise<void>((resolve) => process.nextTick(resolve));
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "ERR_INVALID_ARG_TYPE readable:null end",
    ],
    [
      "a chunk put back, or read(0), between the listener and its event",
      async (log) => {
        const r = source();
        r.push(null);
        drainOnReadable(r, log);
        r.unshift(Buffer.from("a"));
        await turns();
        const nudged = source();
        nudged.push(null);
        nudged.on("readable", () => log(`readable:${show(nudged.read())}`));
        nudged.on("end", () => log("end"));
        log(show(nudged.read(0)));
        await turns();
      },
      "readable B(a) end null readable:null end",
    ],
    [
      "an end that a waiting read observed",
      async (log) => {
        const r = source();
        log(show(r.read()));
        r.push(null);
        r.on("readable", () => log(`readable:${show(r.read())}`));
        r.on("end", () => log("end"));
        await turns();
      },
      "null end",
    ],
  ];

  it.each(scenarios)("%s", async (_name, body, expected) => {
    const events: string[] = [];
    await body((...parts) => events.push(...parts));
    expect(events.join(" ")).toBe(expected);
  });
});

describe("the callbacks of write() and end()", () => {
  /** What each callback was called with, on webnode's streams or the host's. */
  function callbackArguments(module: {
    Writable: typeof NodeWritable;
    Duplex: typeof NodeDuplex;
  }): Promise<string[]> {
    const out: string[] = [];
    const show =
      (label: string) =>
      (...args: unknown[]) =>
        out.push(
          `${label}: ${args.length} ${args.map((arg) => (arg instanceof Error ? arg.message : String(arg)))}`,
        );
    const now = new module.Writable({ write: (_chunk, _encoding, done) => done() });
    const later = new module.Writable({
      write: (_chunk, _encoding, done) => void setImmediate(done),
    });
    const batch = new module.Writable({ writev: (_chunks, done) => void setImmediate(done) });
    const duplex = new module.Duplex({ read() {}, write: (_chunk, _encoding, done) => done() });
    const failing = new module.Writable({
      write: (_chunk, _encoding, done) => done(new Error("refused")),
    });
    failing.on("error", () => {});
    now.write("a", show("write"));
    now.write("a", "utf8", show("write with an encoding"));
    later.write("a", show("write that completes later"));
    later.write("b", show("write queued behind it"));
    batch.cork();
    batch.write("a", show("first of a batch"));
    batch.write("b", show("second of a batch"));
    batch.uncork();
    duplex.write("a", show("write of a duplex"));
    failing.write("a", show("failed write"));
    now.end("z", show("end with a chunk"));
    later.end(show("end"));
    duplex.end("z", "utf8", show("end of a duplex"));
    return new Promise((resolve) => setTimeout(() => resolve(out.sort()), 30));
  }

  it("get null for no error, as in Node, never undefined or nothing", async () => {
    const ours = await callbackArguments(stream as unknown as typeof import("node:stream"));
    expect(ours).toEqual(await callbackArguments(await import("node:stream")));
    expect(ours).toContain("write: 1 null");
    expect(ours).toContain("end: 1 null");
  });

  it("keep the arity Node's methods have", () => {
    expect([Writable.prototype.write.length, Writable.prototype.end.length]).toEqual([3, 3]);
    expect([Duplex.prototype.write.length, Duplex.prototype.end.length]).toEqual([3, 3]);
  });
});

// Real Node v26 and v22 (errs.cjs): each is a plain Error (TypeError for an
// argument) with an own `code`, `toString()` and a stack's first line of
// `Error [CODE]: message`, and `constructor.name` "Error".
describe("the coded errors streams raise", () => {
  const shape = (error: Error & { code?: string }) => ({
    isError: error instanceof Error,
    name: error.name,
    code: error.code,
    constructor: error.constructor.name,
    own: Object.getOwnPropertyNames(error)
      .filter((key) => key !== "stack")
      .sort(),
    keys: Object.keys(error),
    string: String(error),
    stack: String(error.stack).split("\n")[0],
  });
  const caught = (start: (done: (error: Error) => void) => void) =>
    new Promise<Error>((resolve) => start(resolve));
  const writable = () => new Writable({ write: (_c, _e, callback) => callback() });

  it("have Node's shape", async () => {
    const errors: [string, string, Error][] = [
      [
        "ERR_STREAM_WRITE_AFTER_END",
        "write after end",
        await caught((done) => {
          const w = writable();
          w.on("error", done);
          w.end();
          w.write("x");
        }),
      ],
      [
        "ERR_STREAM_PREMATURE_CLOSE",
        "Premature close",
        await caught((done) => {
          const r = new Readable({ read() {} });
          stream.finished(r, (error) => done(error as Error));
          r.destroy();
        }),
      ],
      [
        "ERR_STREAM_PUSH_AFTER_EOF",
        "stream.push() after EOF",
        await caught((done) => {
          const r = new Readable({ read() {} });
          r.on("error", done);
          r.push(null);
          r.push("x");
        }),
      ],
      [
        "ERR_METHOD_NOT_IMPLEMENTED",
        "The _read() method is not implemented",
        await caught((done) => {
          const r = new Readable();
          r.on("error", done);
          r.read();
        }),
      ],
      [
        "ERR_STREAM_DESTROYED",
        "Cannot call write after a stream was destroyed",
        await caught((done) => {
          const w = writable();
          w.destroy();
          w.write("x", (error) => done(error as Error));
        }),
      ],
    ];
    for (const [code, message, error] of errors) {
      expect(shape(error)).toEqual({
        isError: true,
        name: "Error",
        code,
        constructor: "Error",
        own: ["code", "message"],
        keys: ["code"],
        string: `Error [${code}]: ${message}`,
        stack: `Error [${code}]: ${message}`,
      });
    }
  });

  it("start their stack at the stream call that raised them", () => {
    let thrown: (Error & { code?: string }) | undefined;
    try {
      writable().write(42 as never);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    const { name, code, constructor, keys, string } = shape(thrown!);
    expect([name, code, constructor, keys]).toEqual([
      "TypeError",
      "ERR_INVALID_ARG_TYPE",
      "TypeError",
      ["code"],
    ]);
    expect(string.startsWith('TypeError [ERR_INVALID_ARG_TYPE]: The "chunk" argument')).toBe(true);
    const frames = String(thrown!.stack).split("\n").slice(1);
    expect(frames[0]).not.toMatch(/NodeError|NodeShaped|makeNodeError/);
  });
});

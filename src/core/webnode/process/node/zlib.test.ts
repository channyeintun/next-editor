// @vitest-environment node
// The `zlib` builtin: round trips, cross-checks with Node's own zlib in both
// directions, streaming, corrupt input, and the constants table.
import * as nodeZlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "./async_hooks";
import { Buffer } from "./buffer";
import stream from "./stream";
import zlib from "./zlib";

type Sync = (data: Uint8Array, options?: object) => Uint8Array;

interface Format {
  name: string;
  compress: Sync;
  decompress: Sync;
  nodeCompress: Sync;
  nodeDecompress: Sync;
  create: () => ReturnType<typeof zlib.createGzip>;
  createDecompress: () => ReturnType<typeof zlib.createGzip>;
}

const FORMATS: Format[] = [
  {
    name: "gzip",
    compress: zlib.gzipSync,
    decompress: zlib.gunzipSync,
    nodeCompress: nodeZlib.gzipSync,
    nodeDecompress: nodeZlib.gunzipSync,
    create: zlib.createGzip,
    createDecompress: zlib.createGunzip,
  },
  {
    name: "deflate",
    compress: zlib.deflateSync,
    decompress: zlib.inflateSync,
    nodeCompress: nodeZlib.deflateSync,
    nodeDecompress: nodeZlib.inflateSync,
    create: zlib.createDeflate,
    createDecompress: zlib.createInflate,
  },
  {
    name: "deflateRaw",
    compress: zlib.deflateRawSync,
    decompress: zlib.inflateRawSync,
    nodeCompress: nodeZlib.deflateRawSync,
    nodeDecompress: nodeZlib.inflateRawSync,
    create: zlib.createDeflateRaw,
    createDecompress: zlib.createInflateRaw,
  },
];

function random(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function compressible(size: number): Uint8Array {
  const words = new TextEncoder().encode("the quick brown fox jumps over the lazy dog 0123456789 ");
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = words[(i * 7 + (i >> 9)) % words.length];
  }
  return out;
}

const SAMPLES: [string, Uint8Array][] = [
  ["0 bytes", new Uint8Array(0)],
  ["1 byte", new Uint8Array([42])],
  ["1 MB random", random(1 << 20)],
  ["1 MB compressible", compressible(1 << 20)],
];

function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);
}

function capture(fn: () => unknown): { code?: string; errno?: number; message: string } | null {
  try {
    fn();
  } catch (error) {
    const e = error as Error & { code?: string; errno?: number };
    return { code: e.code, errno: e.errno, message: e.message };
  }
  return null;
}

async function pipeChunks(
  transform: ReturnType<typeof zlib.createGzip>,
  data: Uint8Array,
  chunk: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  transform.on("data", (part: Uint8Array) => parts.push(part));
  const finished = new Promise<void>((resolve, reject) => {
    transform.on("end", resolve);
    transform.on("error", reject);
  });
  for (let at = 0; at < data.length; at += chunk) {
    transform.write(data.subarray(at, at + chunk));
  }
  transform.end();
  await finished;
  return Buffer.concat(parts);
}

describe("zlib: sync round trips and cross-checks with node:zlib", () => {
  for (const format of FORMATS) {
    for (const [label, data] of SAMPLES) {
      it(`${format.name} ${label}`, () => {
        const ours = format.compress(data);
        expect(Buffer.isBuffer(ours)).toBe(true);
        expect(same(format.decompress(ours), data)).toBe(true);
        expect(same(format.nodeDecompress(ours), data)).toBe(true);
        expect(same(format.decompress(format.nodeCompress(data)), data)).toBe(true);
      });
    }
    it(`${format.name} at every level`, () => {
      const data = compressible(70000);
      for (let level = -1; level <= 9; level++) {
        const ours = format.compress(data, { level });
        expect(same(format.nodeDecompress(ours), data), `level ${level}`).toBe(true);
      }
    });
  }

  it("unzipSync detects gzip and zlib", () => {
    const data = compressible(5000);
    expect(same(zlib.unzipSync(nodeZlib.gzipSync(data)), data)).toBe(true);
    expect(same(zlib.unzipSync(nodeZlib.deflateSync(data)), data)).toBe(true);
    expect(same(nodeZlib.unzipSync(zlib.gzipSync(data)), data)).toBe(true);
  });

  it("accepts strings, ArrayBuffers and DataViews", () => {
    expect(zlib.gunzipSync(zlib.gzipSync("héllo")).toString()).toBe("héllo");
    const bytes = new TextEncoder().encode("view");
    expect(zlib.inflateSync(zlib.deflateSync(bytes.buffer)).toString()).toBe("view");
    expect(zlib.inflateSync(zlib.deflateSync(new DataView(bytes.buffer))).toString()).toBe("view");
    expect(capture(() => zlib.gzipSync(5 as never))).toEqual(
      capture(() => nodeZlib.gzipSync(5 as never)),
    );
  });

  it("writes Node's gzip header (mtime 0, Unix)", () => {
    const header = Array.from(zlib.gzipSync("").subarray(0, 10));
    expect(header).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
    expect(zlib.deflateSync("").toString("hex")).toBe(nodeZlib.deflateSync("").toString("hex"));
    expect(zlib.deflateRawSync("").toString("hex")).toBe(
      nodeZlib.deflateRawSync("").toString("hex"),
    );
  });

  it("multi-member gzip and zero padding", () => {
    const joined = Buffer.concat([nodeZlib.gzipSync("hello"), nodeZlib.gzipSync(" world")]);
    expect(zlib.gunzipSync(joined).toString()).toBe("hello world");
    const padded = Buffer.concat([nodeZlib.gzipSync("pad"), Buffer.alloc(7)]);
    expect(zlib.gunzipSync(padded).toString()).toBe("pad");
    const garbage = Buffer.concat([nodeZlib.gzipSync("x"), Buffer.from("junk")]);
    expect(capture(() => zlib.gunzipSync(garbage))).toEqual(
      capture(() => nodeZlib.gunzipSync(garbage)),
    );
    const trailing = Buffer.concat([nodeZlib.deflateSync("hello"), Buffer.from("xyz")]);
    expect(zlib.inflateSync(trailing).toString()).toBe("hello");
  });

  it("gzip headers with name, comment, extra and header CRC", () => {
    const body = nodeZlib.deflateRawSync("named");
    const header = [0x1f, 0x8b, 8, 0x1e, 0, 0, 0, 0, 0, 3, 2, 0, 0xaa, 0xbb];
    header.push(...new TextEncoder().encode("file.txt"), 0, ...new TextEncoder().encode("note"), 0);
    const crc = zlib.crc32(new Uint8Array(header)) & 0xffff;
    header.push(crc & 0xff, crc >> 8);
    const size = 5;
    const sum = zlib.crc32("named");
    const trailer = [
      sum & 0xff,
      (sum >>> 8) & 0xff,
      (sum >>> 16) & 0xff,
      sum >>> 24,
      size,
      0,
      0,
      0,
    ];
    const member = Buffer.concat([new Uint8Array(header), body, new Uint8Array(trailer)]);
    expect(nodeZlib.gunzipSync(member).toString()).toBe("named");
    expect(zlib.gunzipSync(member).toString()).toBe("named");
  });

  it("preset dictionaries", () => {
    const dictionary = Buffer.from("hello world dictionary");
    const data = "hello world dictionary hello world";
    const ours = zlib.deflateSync(data, { dictionary });
    expect(nodeZlib.inflateSync(ours, { dictionary }).toString()).toBe(data);
    const theirs = nodeZlib.deflateSync(data, { dictionary });
    expect(zlib.inflateSync(theirs, { dictionary }).toString()).toBe(data);
    expect(capture(() => zlib.inflateSync(theirs))).toEqual(
      capture(() => nodeZlib.inflateSync(theirs)),
    );
    const wrong = { dictionary: Buffer.from("x") };
    expect(capture(() => zlib.inflateSync(theirs, wrong))).toEqual(
      capture(() => nodeZlib.inflateSync(theirs, wrong)),
    );
    const raw = zlib.deflateRawSync(data, { dictionary });
    expect(nodeZlib.inflateRawSync(raw, { dictionary }).toString()).toBe(data);
    expect(
      zlib.inflateRawSync(nodeZlib.deflateRawSync(data, { dictionary }), { dictionary }).toString(),
    ).toBe(data);
  });

  it("small windowBits still produce output Node can read", () => {
    const data = compressible(100000);
    const ours = zlib.deflateRawSync(data, { windowBits: 10 });
    expect(same(nodeZlib.inflateRawSync(ours, { windowBits: 10 }), data)).toBe(true);
    const wrapped = zlib.deflateSync(data, { windowBits: 9 });
    expect(same(nodeZlib.inflateSync(wrapped, { windowBits: 9 }), data)).toBe(true);
  });

  it("finishFlush Z_SYNC_FLUSH reads truncated input", () => {
    const full = nodeZlib.deflateSync("truncated but readable");
    const cut = full.subarray(0, full.length - 4);
    const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
    expect(zlib.inflateSync(cut, options).toString()).toBe(
      nodeZlib.inflateSync(cut, options).toString(),
    );
  });

  it("maxOutputLength", () => {
    const packed = zlib.gzipSync(Buffer.alloc(1000));
    expect(capture(() => zlib.gunzipSync(packed, { maxOutputLength: 10 }))).toEqual(
      capture(() => nodeZlib.gunzipSync(packed, { maxOutputLength: 10 })),
    );
  });

  it("option validation matches Node", () => {
    for (const options of [
      { level: 12 },
      { level: "1" },
      { windowBits: 20 },
      { chunkSize: 10 },
      { strategy: 9 },
      { dictionary: "x" },
    ]) {
      expect(
        capture(() => zlib.gzipSync("a", options as never)),
        `${JSON.stringify(options)}`,
      ).toEqual(capture(() => nodeZlib.gzipSync("a", options as never)));
    }
  });
});

describe("zlib: corrupt input", () => {
  const cases: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["garbage", new TextEncoder().encode("garbage!")],
  ];
  const pairs: [string, Sync, Sync][] = [
    ["inflate", zlib.inflateSync, nodeZlib.inflateSync],
    ["gunzip", zlib.gunzipSync, nodeZlib.gunzipSync],
    ["inflateRaw", zlib.inflateRawSync, nodeZlib.inflateRawSync],
    ["unzip", zlib.unzipSync, nodeZlib.unzipSync],
  ];
  for (const [name, ours, theirs] of pairs) {
    for (const [label, data] of cases) {
      it(`${name} ${label}`, () => {
        const expected = capture(() => theirs(data));
        expect(expected).not.toBeNull();
        expect(capture(() => ours(data))).toEqual(expected);
      });
    }
  }

  it("truncated input, bad checksums, bad lengths", () => {
    const gz = nodeZlib.gzipSync(compressible(20000));
    const truncated = gz.subarray(0, gz.length - 3);
    expect(capture(() => zlib.gunzipSync(truncated))).toEqual(
      capture(() => nodeZlib.gunzipSync(truncated)),
    );
    const badCrc = Buffer.from(gz);
    badCrc[badCrc.length - 6] ^= 1;
    expect(capture(() => zlib.gunzipSync(badCrc))).toEqual(
      capture(() => nodeZlib.gunzipSync(badCrc)),
    );
    const badLength = Buffer.from(gz);
    badLength[badLength.length - 2] ^= 1;
    expect(capture(() => zlib.gunzipSync(badLength))).toEqual(
      capture(() => nodeZlib.gunzipSync(badLength)),
    );
    const z = nodeZlib.deflateSync("adler");
    const badAdler = Buffer.from(z);
    badAdler[badAdler.length - 1] ^= 1;
    expect(capture(() => zlib.inflateSync(badAdler))).toEqual(
      capture(() => nodeZlib.inflateSync(badAdler)),
    );
    const badBlock = Buffer.from([0x78, 0x9c, 0xff, 0xff]);
    expect(capture(() => zlib.inflateSync(badBlock))).toEqual(
      capture(() => nodeZlib.inflateSync(badBlock)),
    );
  });

  it("callback forms report errors with code and errno", async () => {
    const error = await new Promise<Error & { code?: string; errno?: number }>((resolve) => {
      zlib.gunzip(Buffer.from("nope"), (e: Error | null) => resolve(e as Error));
    });
    expect(error.code).toBe("Z_DATA_ERROR");
    expect(error.errno).toBe(-3);
    const truncated = nodeZlib.deflateSync("cut").subarray(0, 4);
    const eof = await new Promise<Error & { code?: string; errno?: number }>((resolve) => {
      zlib.inflate(truncated, (e: Error | null) => resolve(e as Error));
    });
    expect(eof.code).toBe("Z_BUF_ERROR");
    expect(eof.errno).toBe(-5);
  });

  it("streams emit the error", async () => {
    const gunzip = zlib.createGunzip();
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      gunzip.on("error", resolve);
      gunzip.end(Buffer.from("not gzip at all"));
    });
    expect(error.code).toBe("Z_DATA_ERROR");
    expect(error.message).toBe("incorrect header check");
  });
});

describe("zlib: callbacks", () => {
  it("complete asynchronously", async () => {
    let sync = true;
    const result = await new Promise<Buffer>((resolve, reject) => {
      zlib.gzip("later", (error: Error | null, out?: unknown) =>
        error ? reject(error) : resolve(out as Buffer),
      );
      sync = false;
    });
    expect(sync).toBe(false);
    expect(nodeZlib.gunzipSync(result).toString()).toBe("later");
    const back = await new Promise<Buffer>((resolve) => {
      zlib.unzip(result, {}, (_error: Error | null, out?: unknown) => resolve(out as Buffer));
    });
    expect(back.toString()).toBe("later");
    expect(() => zlib.gzip("x", undefined as never)).toThrow(/callback/);
  });

  describe("with the global timers replaced", () => {
    // A fake clock: what it is given never runs. Node's zlib finishes on its
    // thread pool whatever a program did to the global timers.
    const parked = vi.fn<() => void>();
    const replaceTimers = () => {
      parked.mockClear();
      vi.stubGlobal("setTimeout", parked);
      vi.stubGlobal("setInterval", parked);
      vi.stubGlobal("setImmediate", parked);
      vi.stubGlobal("queueMicrotask", parked);
    };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("a compression and a failing decompression still call back", async () => {
      replaceTimers();
      const packed = await new Promise<Buffer>((resolve, reject) =>
        zlib.gzip("hello", (error: Error | null, out?: unknown) =>
          error ? reject(error) : resolve(out as Buffer),
        ),
      );
      expect(nodeZlib.gunzipSync(packed).toString()).toBe("hello");
      const failure = await new Promise<Error | null>((resolve) =>
        zlib.inflate("not deflate data", (error: Error | null) => resolve(error)),
      );
      expect((failure as { code?: string } | null)?.code).toBe("Z_DATA_ERROR");
      expect(parked).not.toHaveBeenCalled();
    });

    it("flush() on a finished stream still calls back", async () => {
      const gzip = zlib.createGzip();
      gzip.resume();
      await new Promise((resolve) => gzip.end("x", () => resolve(null)));
      expect(gzip.writableFinished).toBe(true);
      replaceTimers();
      await new Promise<void>((resolve) => gzip.flush(resolve));
      expect(parked).not.toHaveBeenCalled();
    });
  });

  it("validate options before returning, as Node does", () => {
    for (const z of [zlib, nodeZlib] as const) {
      expect(
        capture(() => (z.gzip as (...a: unknown[]) => void)("abc", { level: 99 }, () => {})),
      ).toEqual(capture(() => nodeZlib.gzipSync("abc", { level: 99 })));
      expect(
        capture(() => (z.inflate as (...a: unknown[]) => void)("abc", { windowBits: 3 }, () => {}))
          ?.code,
      ).toBe("ERR_OUT_OF_RANGE");
    }
  });
});

describe("zlib: streaming", () => {
  for (const format of FORMATS) {
    it(`${format.name} with many small chunks, both directions`, async () => {
      const data = compressible(300000);
      const packed = await pipeChunks(format.create(), data, 997);
      expect(same(format.nodeDecompress(packed), data)).toBe(true);
      const nodePacked = format.nodeCompress(data);
      const unpacked = await pipeChunks(format.createDecompress(), nodePacked, 13);
      expect(same(unpacked, data)).toBe(true);
    });

    it(`${format.name} random data in one-byte chunks`, async () => {
      const data = random(5000, 7);
      const packed = format.nodeCompress(data);
      expect(same(await pipeChunks(format.createDecompress(), packed, 1), data)).toBe(true);
    });
  }

  // Node runs each chunk on its thread pool: the output of a write comes from
  // the event loop, 'finish' does not wait for the last flush, and 'end'
  // follows that flush. (The same order in Node 22 and 26.)
  describe("the order of a stream's events", () => {
    type Zlib = ReturnType<typeof zlib.createGzip>;
    /** The events of `stream`, by name, until 'close' or the event loop has turned `turns` times. */
    async function events(
      create: () => Zlib,
      drive: (stream: Zlib, log: (event: string) => void) => void,
    ): Promise<string[]> {
      const seen: string[] = [];
      const stream = create();
      const closed = new Promise<void>((resolve) => stream.on("close", resolve));
      for (const name of ["finish", "end", "close"]) {
        stream.on(name, () => seen.push(name));
      }
      drive(stream, (event) => seen.push(event));
      await closed;
      return seen;
    }

    it("a write's output, 'finish', the flush's output, 'end', 'close'", async () => {
      const seen = await events(zlib.createGzip, (gzip, log) => {
        gzip.on("data", () => log("data"));
        gzip.end("hello");
        log("returned");
      });
      expect(seen).toEqual(["returned", "data", "finish", "data", "end", "close"]);
    });

    it("write and end callbacks before the data of the end", async () => {
      const seen = await events(zlib.createDeflate, (deflate, log) => {
        deflate.on("data", () => log("data"));
        deflate.write("a".repeat(100000), () => log("write callback"));
        deflate.end(() => log("end callback"));
      });
      expect(seen).toEqual([
        "data",
        "write callback",
        "end callback",
        "finish",
        "data",
        "end",
        "close",
      ]);
    });

    it("a chunk still waiting when the stream ends is the one that finishes it", async () => {
      const seen = await events(zlib.createGzip, (gzip, log) => {
        gzip.on("data", () => log("data"));
        gzip.write("aaa", () => log("first callback"));
        gzip.write("bbb", () => log("second callback"));
        gzip.end(() => log("end callback"));
      });
      expect(seen).toEqual([
        "data",
        "first callback",
        "data",
        "second callback",
        "end callback",
        "finish",
        "end",
        "close",
      ]);
      const packed = nodeZlib.gzipSync("hello world");
      const unpacked = await events(zlib.createGunzip, (gunzip, log) => {
        gunzip.on("data", (chunk: Uint8Array) => log(`data ${Buffer.from(chunk).toString()}`));
        gunzip.write(packed.subarray(0, 12), () => log("first callback"));
        gunzip.write(packed.subarray(12), () => log("second callback"));
        gunzip.end(() => log("end callback"));
      });
      expect(unpacked).toEqual([
        "data h",
        "first callback",
        "data ello world",
        "second callback",
        "end callback",
        "finish",
        "end",
        "close",
      ]);
    });

    it("a chunk's output and callback run in the async context the stream was made in", async () => {
      const storage = new AsyncLocalStorage<string>();
      const stores: string[] = [];
      await new Promise<void>((resolve) => {
        const gzip = storage.run("made", () => zlib.createGzip());
        gzip.on("data", () => stores.push(`data:${storage.getStore()}`));
        gzip.on("end", resolve);
        storage.run("written", () =>
          gzip.write("x", () => stores.push(`callback:${storage.getStore()}`)),
        );
        storage.run("ended", () => gzip.end());
      });
      expect(stores).toEqual(["data:made", "callback:made", "data:made"]);
      // A one-shot call's callback runs in the context of the call.
      const called = await new Promise<unknown>((resolve) =>
        storage.run("called", () => zlib.gzip("x", () => resolve(storage.getStore()))),
      );
      expect(called).toBe("called");
    });

    it("flush() in an 'end' listener finds the stream finished, and calls back", async () => {
      let flushed: Promise<void> | undefined;
      const seen = await events(zlib.createGzip, (gzip, log) => {
        gzip.resume();
        gzip.on("end", () => {
          log(`finished ${gzip.writableFinished}`);
          flushed = new Promise((resolve) => gzip.flush(resolve));
        });
        gzip.end("x");
      });
      expect(seen).toEqual(["finish", "end", "finished true", "close"]);
      await flushed;
    });

    it("a write callback is not called in the caller's own task", async () => {
      const gzip = zlib.createGzip();
      gzip.resume();
      let called = false;
      const written = new Promise<void>((resolve) =>
        gzip.write("abc", () => {
          called = true;
          resolve();
        }),
      );
      // Ticks and promise jobs of this task: the chunk is still on its way.
      await new Promise<void>((resolve) => process.nextTick(resolve));
      for (let hop = 0; hop < 100; hop += 1) {
        await Promise.resolve();
      }
      expect(called).toBe(false);
      await written;
      gzip.destroy();
    });

    it("a chunk that fails destroys the stream from the event loop", async () => {
      const seen = await events(zlib.createInflate, (inflate, log) => {
        inflate.on("error", (error: Error & { code?: string }) => log(`error ${error.code}`));
        inflate.write("not deflate data", () => log("write callback"));
        log("returned");
      });
      expect(seen).toEqual(["returned", "error Z_DATA_ERROR", "close"]);
    });
  });

  it("pipeline with Unzip and bounded output chunks", async () => {
    const data = compressible(200000);
    const parts: Uint8Array[] = [];
    await stream.promises.pipeline(
      stream.Readable.from([nodeZlib.gzipSync(data)]),
      zlib.createUnzip({ chunkSize: 1024 }),
      new stream.Writable({
        write(chunk: Uint8Array, _encoding: string, callback: () => void) {
          parts.push(chunk);
          callback();
        },
      }),
    );
    expect(Math.max(...parts.map((part) => part.length))).toBeLessThanOrEqual(1024);
    expect(same(Buffer.concat(parts), data)).toBe(true);
  });

  it("flush(Z_SYNC_FLUSH) makes everything so far decodable (the ws pattern)", async () => {
    const deflate = zlib.createDeflateRaw();
    const inflate = zlib.createInflateRaw();
    const packed: Uint8Array[] = [];
    deflate.on("data", (chunk: Uint8Array) => packed.push(chunk));
    const messages = ["first message", "second message", "first message again"];
    for (const message of messages) {
      packed.length = 0;
      deflate.write(message);
      await new Promise<void>((resolve) => deflate.flush(zlib.constants.Z_SYNC_FLUSH, resolve));
      const frame = Buffer.concat(packed);
      expect(Array.from(frame.subarray(-4))).toEqual([0, 0, 0xff, 0xff]);
      const out: Uint8Array[] = [];
      const onData = (chunk: Uint8Array) => out.push(chunk);
      inflate.on("data", onData);
      inflate.write(frame);
      await new Promise<void>((resolve) => inflate.flush(resolve));
      inflate.removeListener("data", onData);
      expect(Buffer.concat(out).toString()).toBe(message);
    }
    deflate.close();
    inflate.close();
  });

  it("bytesWritten, reset, params, close", async () => {
    const gzip = new zlib.Gzip();
    gzip.write("12345");
    await new Promise<void>((resolve) => gzip.flush(resolve));
    expect(gzip.bytesWritten).toBe(5);
    await new Promise<void>((resolve) => gzip.params(1, 0, resolve));
    const inflate = zlib.Inflate();
    expect(inflate).toBeInstanceOf(zlib.Inflate);
    expect(inflate).toBeInstanceOf(stream.Transform);
    inflate.reset();
    await new Promise<void>((resolve) => {
      gzip.close(() => resolve());
    });
    expect(gzip.destroyed).toBe(true);
  });

  it("level 0 streams", async () => {
    const data = random(200000, 3);
    const packed = await pipeChunks(zlib.createGzip({ level: 0 }), data, 4096);
    expect(same(nodeZlib.gunzipSync(packed), data)).toBe(true);
  });
});

describe("zlib: module", () => {
  it("constants equal Node's", () => {
    expect({ ...zlib.constants }).toEqual({ ...nodeZlib.constants });
    expect(Object.isFrozen(zlib.constants)).toBe(true);
    expect({ ...zlib.codes }).toEqual({ ...(nodeZlib as unknown as { codes: object }).codes });
  });

  it("has Node's zlib exports, legacy constants included", () => {
    // Node 26's zip-archive API is newer than Node 22.
    const newer = new Set([
      "default",
      "ZipEntry",
      "ZipFile",
      "ZipBuffer",
      "createZipArchive",
      "createZipArchiveSync",
      "zipFiles",
      "getMaxZipContentSize",
      "setMaxZipContentSize",
    ]);
    expect(Object.keys(nodeZlib).filter((name) => !newer.has(name) && !(name in zlib))).toEqual([]);
    const legacy = zlib as unknown as Record<string, unknown>;
    expect(legacy.Z_SYNC_FLUSH).toBe(2);
    expect(Object.keys(zlib)).not.toContain("Z_SYNC_FLUSH");
  });

  it("crc32 matches Node", () => {
    expect(zlib.crc32("hello")).toBe(nodeZlib.crc32("hello"));
    expect(zlib.crc32(Buffer.from("world"), 12345)).toBe(
      nodeZlib.crc32(Buffer.from("world"), 12345),
    );
    const big = random(100003);
    expect(zlib.crc32(big)).toBe(nodeZlib.crc32(big));
    expect(() => zlib.crc32(5 as never)).toThrow(/data/);
  });

  it("brotli and zstd throw an error naming the member", () => {
    expect(() => zlib.brotliCompressSync("x")).toThrow(
      "zlib.brotliCompressSync is not available in webnode",
    );
    expect(() => zlib.createBrotliDecompress()).toThrow(/createBrotliDecompress/);
    expect(() => new zlib.BrotliCompress()).toThrow(/BrotliCompress/);
    expect(() => zlib.zstdDecompressSync("x")).toThrow(/zstdDecompressSync/);
  });
});

// minizlib (the zlib layer of `tar` v6/v7) drives a core zlib object by hand:
// for each write it makes `_handle.close` and `close` no-ops, runs
// `_processChunk(chunk, flushFlag)` (which closes the handle in Node), then
// puts `_handle` back. This replays minizlib 3.1's `write` and `params`.
describe("zlib: minizlib's call pattern", () => {
  type Core = {
    _handle: { close(): void } | null;
    close(): void;
    flush(kind?: unknown, cb?: () => void): void;
    params(level: number, strategy: number, cb?: () => void): void;
    _processChunk(chunk: Uint8Array, flag: number): Uint8Array | Uint8Array[];
    removeAllListeners(event: string): void;
    on(event: string, fn: () => void): void;
  };

  function minizlib(core: Core) {
    const out: Uint8Array[] = [];
    const write = (chunk: Uint8Array, flushFlag: number) => {
      const nativeHandle = core._handle!;
      const originalNativeClose = nativeHandle.close;
      nativeHandle.close = () => {};
      const originalClose = core.close;
      core.close = () => {};
      let result: Uint8Array | Uint8Array[];
      try {
        result = core._processChunk(chunk, flushFlag);
      } finally {
        core._handle = nativeHandle;
        nativeHandle.close = originalNativeClose;
        core.close = originalClose;
        core.removeAllListeners("error");
      }
      core.on("error", () => {});
      for (const part of Array.isArray(result) ? result : [result]) {
        out.push(Uint8Array.from(part));
      }
    };
    const params = (level: number, strategy: number) => {
      write(new Uint8Array(0), nodeZlib.constants.Z_SYNC_FLUSH);
      const origFlush = core.flush;
      core.flush = (flag: unknown, cb?: () => void) => {
        write(new Uint8Array(0), flag as number);
        cb?.();
      };
      try {
        core.params(level, strategy);
      } finally {
        core.flush = origFlush;
      }
    };
    return { out, write, params };
  }

  it("gzips and gunzips through _handle and _processChunk", () => {
    const text = compressible(50_000);
    for (const z of [zlib, nodeZlib] as const) {
      const gzip = z.createGzip() as unknown as Core;
      expect(gzip._handle).toBeTruthy();
      expect(typeof gzip._handle!.close).toBe("function");
      const mz = minizlib(gzip);
      mz.write(text.subarray(0, 20_000), nodeZlib.constants.Z_NO_FLUSH);
      mz.write(new Uint8Array(0), nodeZlib.constants.Z_FULL_FLUSH);
      mz.params(9, nodeZlib.constants.Z_DEFAULT_STRATEGY);
      mz.write(text.subarray(20_000), nodeZlib.constants.Z_NO_FLUSH);
      mz.write(new Uint8Array(0), nodeZlib.constants.Z_FINISH);
      const gz = Buffer.concat(mz.out);
      expect(same(nodeZlib.gunzipSync(gz), text)).toBe(true);

      const gunzip = z.createGunzip() as unknown as Core;
      const back = minizlib(gunzip);
      back.write(gz.subarray(0, 100), nodeZlib.constants.Z_NO_FLUSH);
      back.write(gz.subarray(100), nodeZlib.constants.Z_NO_FLUSH);
      back.write(new Uint8Array(0), nodeZlib.constants.Z_FINISH);
      expect(same(Buffer.concat(back.out), text)).toBe(true);
      // The real close still closes.
      gunzip.close();
      expect(gunzip._handle).toBeNull();
    }
  });

  it("closes the handle after a plain _processChunk, as Node does", () => {
    const ours = zlib.createGzip() as unknown as Core & { _closed: boolean; destroyed: boolean };
    const theirs = nodeZlib.createGzip() as unknown as typeof ours;
    for (const core of [ours, theirs]) {
      core._processChunk(Buffer.from("hi"), nodeZlib.constants.Z_FINISH);
      expect([core._handle, core._closed, core.destroyed]).toEqual([null, true, false]);
      // Node fails reading the null handle; webnode names the closed binding.
      expect(capture(() => core._processChunk(Buffer.from("hi"), 0))).not.toBeNull();
    }
  });
});

describe("zlib: truncated input with finishFlush Z_SYNC_FLUSH", () => {
  // The same compressed bytes (Node's) decode to as much as Node decodes at
  // every cut. (Output from different compressors differs at a given cut.)
  it("returns every byte Node decodes", () => {
    const text = Buffer.from(
      "hello world ".repeat(5000) +
        Array.from({ length: 3000 }, (_, i) => String((i * 7919) % 1000)).join(","),
    );
    const options = { finishFlush: nodeZlib.constants.Z_SYNC_FLUSH };
    const pairs = [
      [nodeZlib.gzipSync(text), "gunzipSync"],
      [nodeZlib.deflateSync(text), "inflateSync"],
      [nodeZlib.deflateRawSync(text), "inflateRawSync"],
      [nodeZlib.gzipSync(text), "unzipSync"],
    ] as const;
    for (const [compressed, method] of pairs) {
      for (const cut of [12, 50, 100, 101, 257, 1000, compressed.length - 4]) {
        const input = compressed.subarray(0, cut);
        expect([method, cut, zlib[method](input, options).length]).toEqual([
          method,
          cut,
          nodeZlib[method](input, options).length,
        ]);
      }
    }
  });
});

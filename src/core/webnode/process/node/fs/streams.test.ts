// @vitest-environment node
// fs.ReadStream / fs.WriteStream against the host's real `node:fs`: ranges,
// highWaterMark chunking, encodings, the fd and fs options, autoClose,
// backpressure, events and counters.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import webnodeFs from "../fs";
import { createProcess } from "../process";
import { makeSides, runAsync, scenarioDirs, type AnyFs, type Sides } from "./compare.testkit";

const fs = webnodeFs as unknown as AnyFs;

let sides: Sides;

beforeEach(() => {
  sides = makeSides();
});

afterEach(() => {
  sides.cleanup();
});

interface Collected {
  chunks: unknown[];
  events: string[];
  bytesRead?: number;
}

function collect(
  stream: NodeJS.ReadableStream & { bytesRead?: number },
  until = "close",
): Promise<Collected> {
  return new Promise((resolve, reject) => {
    const result: Collected = { chunks: [], events: [] };
    for (const event of ["open", "ready", "end", "close"]) {
      stream.on(event, () => {
        result.events.push(event);
        if (event === until) {
          result.bytesRead = stream.bytesRead;
          resolve(result);
        }
      });
    }
    stream.on("data", (chunk: unknown) => {
      result.chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("latin1"));
    });
    stream.on("error", reject);
  });
}

const scenarios: { name: string; run: (f: AnyFs, d: string) => Promise<unknown> }[] = [
  {
    name: "read ranges and highWaterMark",
    run: async (f, d) => {
      f.writeFileSync(`${d}/r`, "abcdefghij");
      return [
        await collect(f.createReadStream(`${d}/r`, { highWaterMark: 3 })),
        await collect(f.createReadStream(`${d}/r`, { start: 2, end: 6, highWaterMark: 2 })),
        await collect(f.createReadStream(`${d}/r`, { start: 8 })),
        await collect(f.createReadStream(`${d}/r`, { end: 0 })),
        await collect(f.createReadStream(`${d}/r`, { encoding: "hex", start: 1, end: 2 })),
        await collect(f.createReadStream(`${d}/r`, "utf8")),
      ];
    },
  },
  {
    name: "read with fd and autoClose",
    run: async (f, d) => {
      f.writeFileSync(`${d}/r`, "0123456789");
      const fd = f.openSync(`${d}/r`, "r");
      const first = await collect(
        f.createReadStream("", { fd, autoClose: false, end: 3 }) as never,
        "end",
      );
      const kept = f.readSync(fd, Buffer.alloc(2), 0, 2, null);
      const second = await collect(f.createReadStream("", { fd, start: 6 }) as never).catch(
        (error: Error & { code?: string }) => error.code,
      );
      return [
        first,
        kept,
        second,
        (() => {
          try {
            f.fstatSync(fd);
            return "open";
          } catch (error) {
            return (error as { code?: string }).code;
          }
        })(),
      ];
    },
  },
  {
    name: "missing file",
    run: (f, d) =>
      new Promise((resolve) => {
        const stream = f.createReadStream(`${d}/missing`);
        stream.on("error", (error: Error & { code?: string; syscall?: string }) =>
          resolve([error.code, error.syscall, stream.pending]),
        );
      }),
  },
  {
    name: "write stream",
    run: async (f, d) => {
      const file = `${d}/w`;
      const stream = f.createWriteStream(file, { highWaterMark: 4 });
      const events: string[] = [];
      stream.on("open", () => events.push("open"));
      stream.on("ready", () => events.push("ready"));
      stream.on("finish", () => events.push("finish"));
      stream.on("drain", () => events.push("drain"));
      const pendingAtStart = stream.pending;
      const first = stream.write("abcdef");
      const second = stream.write(Buffer.from("gh"));
      await new Promise<void>((resolve) => stream.end("ij", () => resolve()));
      await new Promise<void>((resolve) =>
        stream.closed ? resolve() : stream.on("close", () => resolve()),
      );
      events.push("close");
      f.writeFileSync(`${d}/s`, "0123456789");
      const ranged = f.createWriteStream(`${d}/s`, { flags: "r+", start: 3 });
      ranged.write("XY");
      await new Promise<void>((resolve) => ranged.end("Z", () => resolve()));
      const appended = f.createWriteStream(`${d}/s`, { flags: "a", encoding: "hex" });
      appended.write("2121");
      await new Promise<void>((resolve) => appended.close(() => resolve()));
      return [
        pendingAtStart,
        first,
        second,
        events,
        stream.bytesWritten,
        f.readFileSync(file, "utf8"),
        ranged.bytesWritten,
        f.readFileSync(`${d}/s`, "utf8"),
      ];
    },
  },
  {
    name: "write stream errors",
    run: (f, d) =>
      new Promise((resolve) => {
        const stream = f.createWriteStream(`${d}/missing/w`);
        stream.on("error", (error: Error & { code?: string; syscall?: string }) =>
          resolve([error.code, error.syscall]),
        );
      }),
  },
  {
    name: "FileHandle streams",
    run: async (f, d) => {
      f.writeFileSync(`${d}/h`, "handle data");
      const handle = await f.promises.open(`${d}/h`, "r+");
      const read = await collect(handle.createReadStream({ start: 7 }) as never);
      const handle2 = await f.promises.open(`${d}/h`, "r+");
      const writer = handle2.createWriteStream({ start: 0 });
      await new Promise<void>((resolve) => writer.end("H", () => resolve()));
      await new Promise<void>((resolve) =>
        writer.closed ? resolve() : writer.on("close", () => resolve()),
      );
      return [read, handle.fd, handle2.fd, f.readFileSync(`${d}/h`, "utf8")];
    },
  },
];

describe("file streams against node:fs", () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    async (_name, scenario) => {
      const dirs = scenarioDirs(sides, scenario.name.replace(/\W+/g, "_"));
      const ours = await runAsync(sides.ours, dirs.ours, scenario.run);
      const node = await runAsync(sides.node, dirs.node, scenario.run);
      expect(ours).toEqual(node);
    },
  );
});

describe("stream specifics", () => {
  it("uses the fs override for its I/O", async () => {
    fs.writeFileSync("/work/o", "override");
    const calls: string[] = [];
    const custom = {
      open: (...args: Parameters<typeof fs.open>) => {
        calls.push("open");
        return (fs.open as (...a: unknown[]) => void)(...args);
      },
      read: (...args: unknown[]) => {
        calls.push("read");
        return (fs.read as (...a: unknown[]) => void)(...args);
      },
      close: (...args: unknown[]) => {
        calls.push("close");
        return (fs.close as (...a: unknown[]) => void)(...args);
      },
    };
    const got = await collect(fs.createReadStream("/work/o", { fs: custom } as never) as never);
    expect(got.chunks).toEqual(["override"]);
    expect(calls).toEqual(["open", "read", "read", "close"]);
  });

  it("honours a monkey-patched open(), the way graceful-fs subclasses ReadStream", async () => {
    fs.writeFileSync("/work/g", "graceful");
    const Base = fs.ReadStream as unknown as (
      this: unknown,
      path: unknown,
      options?: unknown,
    ) => void;
    function Graceful(
      this: {
        path: string;
        flags: string;
        mode: number;
        fd: number;
        emit(e: string, v: unknown): void;
      },
      path: unknown,
      options?: unknown,
    ) {
      Base.call(this, path, options);
    }
    Graceful.prototype = Object.create(
      (fs.ReadStream as unknown as { prototype: object }).prototype,
    );
    Graceful.prototype.open = function (this: {
      path: string;
      flags: string;
      mode: number;
      fd: number;
      emit(e: string, v: unknown): void;
    }) {
      fs.open(this.path, this.flags, this.mode, (error, fd) => {
        if (error) {
          this.emit("error", error);
          return;
        }
        this.fd = fd;
        this.emit("open", fd);
      });
    };
    const stream = new (Graceful as unknown as new (p: string) => NodeJS.ReadableStream)("/work/g");
    const got = await collect(stream as never);
    expect(got.chunks).toEqual(["graceful"]);
    expect(got.events).toContain("open");
  });

  it("stops at an AbortSignal", async () => {
    fs.writeFileSync("/work/a", "x".repeat(100));
    const controller = new AbortController();
    const stream = fs.createReadStream("/work/a", { signal: controller.signal, highWaterMark: 10 });
    const error = await new Promise<Error>((resolve) => {
      stream.on("error", resolve);
      stream.once("data", () => controller.abort());
    });
    expect(error.name).toBe("AbortError");
  });

  it("reports a failed read of a stream that does not destroy itself, whatever the program made of queueMicrotask", async () => {
    fs.writeFileSync("/work/e", "data");
    const failing = {
      open: fs.open,
      close: fs.close,
      read: (...args: unknown[]) =>
        (args[args.length - 1] as (error: Error) => void)(
          Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }),
        ),
    };
    // Without autoClose a file stream does not destroy itself on an error.
    const stream = fs.createReadStream("/work/e", { fs: failing, autoClose: false } as never);
    const real = globalThis.queueMicrotask;
    // What a test's fake timers leave: jobs that wait for a clock nobody advances.
    const faked: unknown[] = [];
    globalThis.queueMicrotask = (job) => void faked.push(job);
    let outcome;
    try {
      outcome = await Promise.race([
        new Promise((resolve) =>
          stream.on("error", (error: Error & { code?: string }) => resolve(error.code)),
        ),
        new Promise((resolve) => stream.on("data", resolve)),
        new Promise((resolve) => setTimeout(() => resolve("no error event"), 200)),
      ]);
    } finally {
      globalThis.queueMicrotask = real;
    }
    expect(outcome).toBe("EIO");
    expect(faked).toEqual([]);
    // As Node's errorOrDestroy leaves a stream it did not destroy.
    expect([stream.destroyed, stream.errored?.message]).toEqual([false, "EIO: i/o error, read"]);
    stream.destroy();
  });

  for (const side of ["node", "ours"] as const) {
    it(`${side}: close(callback) on a closed WriteStream calls back on the next tick`, async () => {
      const { fs: sideFs, root } = sides[side];
      if (side === "ours") {
        // A process: ticks then run in Node's order.
        createProcess({ loadBuiltin: () => undefined, ipc: null });
      }
      const stream = sideFs.createWriteStream(`${root}/w`);
      await new Promise((resolve) => stream.end(resolve));
      await new Promise((resolve) => (stream.closed ? resolve(null) : stream.on("close", resolve)));
      const order: string[] = [];
      await new Promise<void>((resolve) => {
        // In a callback from the event loop, where a tick runs before a promise job.
        sideFs.stat(root, () => {
          void Promise.resolve().then(() => order.push("promise"));
          stream.close(() => {
            order.push("close callback");
            resolve();
          });
          order.push("after close call");
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(order).toEqual(["after close call", "close callback", "promise"]);
    });
  }
});

// @vitest-environment node
// The callback and promise `fs` APIs (with FileHandle), run against the
// host's real `node:fs` and compared step by step, plus webnode-only checks.
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "./fs";
import fsPromises from "./fs_promises";
import { makeSides, runAsync, scenarioDirs, type AnyFs, type Sides } from "./fs/compare.testkit";

let sides: Sides;

beforeEach(() => {
  sides = makeSides();
});

afterEach(() => {
  sides.cleanup();
});

interface AsyncScenario {
  name: string;
  run: (fs: AnyFs, dir: string) => Promise<unknown>;
}

/** Settles `fn` into its value or the error's code/syscall/message. */
async function settled(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await fn();
    return value === undefined ? "ok" : value;
  } catch (error) {
    const e = error as Error & { code?: unknown; syscall?: unknown };
    return { code: e.code, syscall: e.syscall, name: e.name };
  }
}

/** Calls a callback-style function and resolves with every argument its callback got. */
function callbackArgs(call: (callback: (...args: unknown[]) => void) => void): Promise<unknown[]> {
  return new Promise((resolve) => {
    call((...args: unknown[]) => {
      resolve(
        args.map((arg) =>
          arg instanceof Error ? { code: (arg as { code?: unknown }).code, name: arg.name } : arg,
        ),
      );
    });
  });
}

const scenarios: AsyncScenario[] = [
  {
    name: "callbacks run asynchronously",
    run: async (f, d) => {
      const order: string[] = [];
      await new Promise<void>((resolve) => {
        f.stat(d, (error) => {
          order.push(error ? "error" : "callback");
          resolve();
        });
        order.push("returned");
      });
      return order;
    },
  },
  {
    name: "callback results and errors",
    run: async (f, d) => [
      await callbackArgs((cb) => f.writeFile(`${d}/a`, "abc", cb)),
      await callbackArgs((cb) => f.readFile(`${d}/a`, "utf8", cb)),
      await callbackArgs((cb) => f.readFile(`${d}/missing`, cb)),
      await callbackArgs((cb) => f.mkdir(`${d}/m/n`, { recursive: true }, cb)),
      await callbackArgs((cb) => f.mkdir(`${d}/plain`, cb)),
      await callbackArgs((cb) => f.readdir(d, cb)).then((args) => [
        args[0],
        [...(args[1] as string[])].sort(),
      ]),
      await callbackArgs((cb) => f.access(`${d}/a`, cb)),
      await callbackArgs((cb) => f.access(`${d}/a`, f.constants.W_OK, cb)),
      await callbackArgs((cb) => f.exists(`${d}/a`, cb as (exists: boolean) => void)),
      await callbackArgs((cb) => f.rm(`${d}/m`, cb)),
      await callbackArgs((cb) => f.rm(`${d}/m`, { recursive: true }, cb)),
      await callbackArgs((cb) => f.copyFile(`${d}/a`, `${d}/b`, cb)),
      await callbackArgs((cb) => f.rename(`${d}/b`, `${d}/c`, cb)),
      await callbackArgs((cb) => f.unlink(`${d}/c`, cb)),
      await callbackArgs((cb) => f.truncate(`${d}/a`, 1, cb)),
      await callbackArgs((cb) => f.appendFile(`${d}/a`, "z", cb)),
      await callbackArgs((cb) => f.readFile(`${d}/a`, { encoding: "utf8" }, cb)),
      await callbackArgs((cb) => f.symlink("a", `${d}/l`, cb)),
      await callbackArgs((cb) => f.readlink(`${d}/l`, cb)),
      await callbackArgs((cb) => f.lstat(`${d}/l`, cb)).then((args) => [
        args[0],
        (args[1] as { isSymbolicLink(): boolean }).isSymbolicLink(),
      ]),
      await callbackArgs((cb) => f.realpath(`${d}/l`, cb)),
      await callbackArgs((cb) => f.realpath.native(`${d}/l`, cb)),
      await callbackArgs((cb) => f.cp(`${d}/a`, `${d}/cp`, cb)),
      await callbackArgs((cb) => f.readFile(`${d}/cp`, "utf8", cb)),
    ],
  },
  {
    name: "aborted signal",
    run: async (f, d) => {
      const controller = new AbortController();
      controller.abort();
      return [
        await callbackArgs((cb) => f.readFile(`${d}/x`, { signal: controller.signal }, cb)),
        await callbackArgs((cb) => f.writeFile(`${d}/x`, "x", { signal: controller.signal }, cb)),
        f.existsSync(`${d}/x`),
        await settled(() => f.promises.readFile(`${d}/x`, { signal: controller.signal })),
      ];
    },
  },
  {
    name: "read and write overloads",
    run: async (f, d) => {
      const file = `${d}/rw`;
      f.writeFileSync(file, "0123456789");
      const fd = f.openSync(file, "r+");
      const out: unknown[] = [];
      const buf = Buffer.alloc(4);
      out.push(await callbackArgs((cb) => f.read(fd, buf, 0, 2, 0, cb)));
      out.push(await callbackArgs((cb) => f.read(fd, buf, { position: 5, length: 3 }, cb)));
      out.push(
        await callbackArgs((cb) => f.read(fd, { buffer: Buffer.alloc(3), position: 1 }, cb)),
      );
      out.push(await callbackArgs((cb) => f.read(fd, Buffer.alloc(2), cb)));
      out.push(
        await callbackArgs((cb) =>
          (f.read as unknown as (fd: number, cb: (...a: unknown[]) => void) => void)(fd, cb),
        ).then((args) => [args[0], args[1], (args[2] as Buffer).length]),
      );
      out.push(await callbackArgs((cb) => f.read(fd, buf, 0, 0, 0, cb)));
      out.push(await callbackArgs((cb) => f.write(fd, "ab", cb)));
      out.push(await callbackArgs((cb) => f.write(fd, "cd", 0, cb)));
      out.push(await callbackArgs((cb) => f.write(fd, "6566", 4, "hex", cb)));
      out.push(await callbackArgs((cb) => f.write(fd, Buffer.from("XYZ"), cb)));
      out.push(await callbackArgs((cb) => f.write(fd, Buffer.from("XYZ"), 1, cb)));
      out.push(await callbackArgs((cb) => f.write(fd, Buffer.from("XYZ"), 1, 1, 8, cb)));
      out.push(await callbackArgs((cb) => f.write(fd, Buffer.from("QR"), { position: 9 }, cb)));
      out.push(
        await callbackArgs((cb) => f.writev(fd, [Buffer.from("m"), Buffer.from("n")], 2, cb)),
      );
      out.push(await callbackArgs((cb) => f.readv(fd, [Buffer.alloc(3), Buffer.alloc(3)], 0, cb)));
      out.push(
        await callbackArgs((cb) => f.fstat(fd, cb)).then((args) => [
          args[0],
          (args[1] as { size: number }).size,
        ]),
      );
      out.push(await callbackArgs((cb) => f.ftruncate(fd, 4, cb)));
      out.push(await callbackArgs((cb) => f.fsync(fd, cb)));
      out.push(await callbackArgs((cb) => f.fdatasync(fd, cb)));
      out.push(await callbackArgs((cb) => f.close(fd, cb)));
      out.push(await callbackArgs((cb) => f.close(fd, cb)));
      out.push(f.readFileSync(file, "latin1"));
      return out;
    },
  },
  {
    name: "promisified read, write and exists",
    run: async (f, d) => {
      const file = `${d}/p`;
      f.writeFileSync(file, "hello");
      const fd = f.openSync(file, "r+");
      const read = await promisify(f.read)(fd, Buffer.alloc(5), 0, 5, 0);
      const written = await promisify(f.write)(fd, Buffer.from("J"), 0, 1, 0);
      const writtenString = await (
        promisify(f.write) as unknown as (fd: number, s: string) => Promise<unknown>
      )(fd, "!");
      const readv = await promisify(f.readv)(fd, [Buffer.alloc(2)], 0);
      f.closeSync(fd);
      return [
        read,
        written,
        writtenString,
        readv,
        await promisify(f.exists)(file),
        await promisify(f.exists)(`${d}/missing`),
        await promisify(f.stat)(file).then((stats) => stats.size),
      ];
    },
  },
  {
    name: "promises API",
    run: async (f, d) => {
      const p = f.promises;
      const out: unknown[] = [];
      out.push(await settled(() => p.writeFile(`${d}/a`, "alpha")));
      out.push(await settled(() => p.appendFile(`${d}/a`, Buffer.from("!"))));
      out.push(await settled(() => p.readFile(`${d}/a`, "utf8")));
      out.push(await settled(() => p.writeFile(`${d}/it`, ["x", Buffer.from("y"), "z"])));
      out.push(
        await settled(() =>
          p.writeFile(
            `${d}/ait`,
            (async function* () {
              yield "as";
              yield "ync";
            })(),
          ),
        ),
      );
      out.push(f.readFileSync(`${d}/it`, "utf8"), f.readFileSync(`${d}/ait`, "utf8"));
      out.push(await settled(() => p.mkdir(`${d}/x/y`, { recursive: true })));
      out.push(await settled(() => p.readdir(d).then((names) => [...names].sort())));
      out.push(await settled(() => p.stat(`${d}/a`).then((s) => [s.size, s.isFile()])));
      out.push(await settled(() => p.lstat(`${d}/missing`)));
      out.push(await settled(() => p.access(`${d}/a`)));
      out.push(await settled(() => p.copyFile(`${d}/a`, `${d}/b`)));
      out.push(await settled(() => p.rename(`${d}/b`, `${d}/c`)));
      out.push(await settled(() => p.rm(`${d}/x`)));
      out.push(await settled(() => p.rm(`${d}/x`, { recursive: true })));
      out.push(await settled(() => p.rmdir(`${d}/x`)));
      out.push(await settled(() => p.symlink("c", `${d}/l`)));
      out.push(await settled(() => p.readlink(`${d}/l`)));
      out.push(await settled(() => p.realpath(`${d}/l`)));
      out.push(await settled(() => p.truncate(`${d}/c`, 2)));
      out.push(
        await settled(() => p.utimes(`${d}/c`, 1, 2).then(() => f.statSync(`${d}/c`).mtimeMs)),
      );
      out.push(
        await settled(() => p.chmod(`${d}/c`, 0o600).then(() => f.statSync(`${d}/c`).mode & 0o777)),
      );
      out.push(await settled(() => p.unlink(`${d}/c`)));
      out.push(
        await settled(() => p.mkdtemp(`${d}/t-`).then((made) => made.length - `${d}/t-`.length)),
      );
      out.push(await settled(() => p.stat(123 as unknown as string)));
      out.push(await settled(() => p.readFile(`${d}/missing`)));
      out.push(await settled(() => p.cp(`${d}/it`, `${d}/cp-it`, { filter: async () => true })));
      out.push(await settled(() => p.cp(`${d}/it`, `${d}/cp-no`, { filter: async () => false })));
      out.push(f.existsSync(`${d}/cp-it`), f.existsSync(`${d}/cp-no`));
      out.push(
        await settled(() =>
          p.opendir(d).then(async (dir) => {
            const names: string[] = [];
            for await (const entry of dir) {
              names.push(entry.name);
            }
            return names.filter((name) => !name.startsWith("t-")).sort();
          }),
        ),
      );
      out.push(p.constants === f.constants);
      return out;
    },
  },
  {
    name: "FileHandle",
    run: async (f, d) => {
      const out: unknown[] = [];
      const handle = await f.promises.open(`${d}/h`, "w+");
      out.push(typeof handle.fd);
      out.push(await handle.write("hello world"));
      out.push(await handle.write(Buffer.from("HE"), 0, 2, 0));
      out.push(await handle.write(Buffer.from("xyz"), { offset: 1, length: 1, position: 4 }));
      out.push(await handle.read(Buffer.alloc(5), 0, 5, 0));
      out.push(await handle.read({ buffer: Buffer.alloc(3), position: 6 }));
      out.push(await handle.read(Buffer.alloc(4), { position: 1, length: 2 }));
      out.push(await handle.readv([Buffer.alloc(2), Buffer.alloc(2)], 0));
      out.push(await handle.writev([Buffer.from("A"), Buffer.from("B")], 9));
      out.push((await handle.stat()).size);
      out.push(await handle.truncate(8));
      await handle.write("", 0);
      out.push(await handle.readFile("utf8"));
      out.push(await handle.read(Buffer.alloc(3), 0, 3, 0).then(() => handle.readFile("utf8")));
      out.push(await handle.writeFile("tail"));
      out.push(f.readFileSync(`${d}/h`, "utf8"));
      out.push(await handle.chmod(0o640));
      out.push(await handle.utimes(1, 2));
      out.push(await handle.sync());
      out.push(await handle.datasync());
      out.push(await handle.close());
      out.push(await handle.close());
      out.push(handle.fd);
      out.push(await settled(() => handle.stat()));
      out.push(await settled(() => handle.read(Buffer.alloc(1), 0, 1, 0)));
      const lines = await f.promises.open(`${d}/lines`, "w+");
      await lines.writeFile("one\ntwo\r\nthree");
      await lines.close();
      const reader = await f.promises.open(`${d}/lines`);
      const got: string[] = [];
      for await (const line of reader.readLines()) {
        got.push(line);
      }
      out.push(got);
      const web = await f.promises.open(`${d}/lines`);
      const chunks: number[] = [];
      for await (const chunk of web.readableWebStream() as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk.length);
      }
      await web.close();
      out.push(chunks);
      out.push(await settled(() => f.promises.open(`${d}/missing`)));
      return out;
    },
  },
];

describe("callback and promise APIs against node:fs", () => {
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

describe("webnode specifics", () => {
  it("fs/promises is fs.promises, with Node 22's keys", () => {
    expect(fsPromises).toBe(fs.promises);
    expect(Object.keys(fsPromises)).toEqual([
      "access",
      "copyFile",
      "cp",
      "glob",
      "open",
      "opendir",
      "rename",
      "truncate",
      "rm",
      "rmdir",
      "mkdir",
      "readdir",
      "readlink",
      "symlink",
      "lstat",
      "stat",
      "statfs",
      "link",
      "unlink",
      "chmod",
      "lchmod",
      "lchown",
      "chown",
      "utimes",
      "lutimes",
      "realpath",
      "mkdtemp",
      "writeFile",
      "appendFile",
      "readFile",
      "watch",
      "constants",
    ]);
  });

  it("validation errors reject in the promise API and throw in the callback API", async () => {
    await expect(fsPromises.mkdir(5 as unknown as string)).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    expect(() => fs.mkdir(5 as unknown as string, () => {})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => fs.close(1, 5 as unknown as () => void)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("rm retries after retryDelay", async () => {
    fs.mkdirSync("/work/busy");
    let calls = 0;
    // Node's asynchronous rm removes an empty directory with rmdir (rimraf).
    const original = sides.runtime.fs.rmdir;
    sides.runtime.fs.rmdir = (path) => {
      calls++;
      if (calls < 3) {
        const error = new Error("EBUSY: resource busy or locked, rmdir") as Error & {
          code: string;
          syscall: string;
          errno: number;
        };
        error.code = "EBUSY";
        error.syscall = "rmdir";
        error.errno = -16;
        throw error;
      }
      original(path);
    };
    const started = Date.now();
    await fsPromises.rm("/work/busy", { recursive: true, maxRetries: 3, retryDelay: 5 });
    expect(calls).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(fs.existsSync("/work/busy")).toBe(false);
    await expect(fsPromises.rm("/work/none", { maxRetries: 0 })).rejects.toMatchObject({
      code: "ENOENT",
      syscall: "lstat",
    });
  });

  it("rm retries on the platform's clock, whatever the program made of setTimeout", async () => {
    fs.mkdirSync("/work/busy");
    let calls = 0;
    const original = sides.runtime.fs.rmdir;
    sides.runtime.fs.rmdir = (path) => {
      calls++;
      if (calls < 2) {
        throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), {
          code: "EBUSY",
          syscall: "rmdir",
          errno: -16,
        });
      }
      original(path);
    };
    const real = globalThis.setTimeout;
    // What a test's fake timers leave: a setTimeout that never fires.
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    let removal;
    try {
      removal = fsPromises.rm("/work/busy", { recursive: true, maxRetries: 1, retryDelay: 1 });
      // The retry is asked for while the program's setTimeout is the fake.
      await Promise.resolve();
    } finally {
      globalThis.setTimeout = real;
    }
    const outcome = await Promise.race([
      removal.then(() => "removed"),
      new Promise((resolve) => real(() => resolve("never retried"), 200)),
    ]);
    expect(outcome).toBe("removed");
    expect(calls).toBe(2);
  });

  it("Symbol.asyncDispose closes a FileHandle", async () => {
    const handle = await fsPromises.open("/work/disposable", "w");
    await handle[Symbol.asyncDispose]();
    expect(handle.fd).toBe(-1);
  });

  it("openAsBlob reads the file", async () => {
    fs.writeFileSync("/work/blob", "blob!");
    const blob = await fs.openAsBlob("/work/blob", { type: "text/plain" });
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("blob!");
  });

  it("glob is not provided and says so", () => {
    expect(() => (fsPromises.glob as (pattern: string) => unknown)("*")).toThrow(
      "The fsPromises.glob() method is not implemented",
    );
  });
});

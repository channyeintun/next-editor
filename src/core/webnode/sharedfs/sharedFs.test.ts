// @vitest-environment node
// What the binding itself adds over the module: several instances on one
// memory, a memory that grows under a view, the argument area's limit, handle
// numbers the module reuses, the event log handed from a process to the
// kernel, slots, and booting where the engine cannot.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemError } from "../errors";
import {
  O_APPEND,
  O_CREAT,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  type VfsWatchEvent,
} from "../kernel/vfs/types";
import { ARGS_CAPACITY, OFFSET, PROCESS_SLOTS } from "./abi";
import { createSharedFilesystem, type SharedFilesystem } from "./boot";
import { SharedFs } from "./sharedFs";

const WRITE = O_WRONLY | O_CREAT | O_TRUNC;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function boot(now?: () => number): SharedFilesystem {
  const shared = createSharedFilesystem({ now });
  if (shared === null) {
    throw new Error("this engine cannot make the shared filesystem");
  }
  return shared;
}

/** A process's instance, entering through a slot of its own. */
function join(shared: SharedFilesystem): SharedFs {
  const entry = shared.admit();
  if (entry === null) {
    throw new Error("no free slot");
  }
  return new SharedFs({
    module: shared.module,
    memory: shared.memory,
    now: Date.now,
    entry,
    deliversEvents: false,
  });
}

function failure(action: () => unknown): Partial<SystemError> {
  try {
    action();
  } catch (error) {
    const { code, syscall, path, dest, message } = error as SystemError;
    return { code, syscall, path, dest, message };
  }
  throw new Error("expected the call to throw");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instances on one memory", () => {
  it("see each other's changes at once", () => {
    const shared = boot();
    const process = join(shared);
    process.mkdir("/app/src", true, 0o777);
    process.writeFile("/app/src/index.js", encoder.encode("one"), WRITE, 0o644);
    expect(decoder.decode(shared.fs.readFile("/app/src/index.js"))).toBe("one");
    shared.fs.rename("/app/src/index.js", "/app/src/main.js");
    expect(process.readdir("/app/src")).toEqual([{ name: "main.js", type: "file" }]);
    expect(process.totals()).toEqual(shared.fs.totals());
    expect(shared.fs.check()).toBe(0);
  });

  it("read past a memory that grew under an older view", () => {
    const shared = boot();
    const process = join(shared);
    const before = shared.memory.buffer.byteLength;
    // Far more than the initial pages: the memory grows during this call.
    const big = new Uint8Array(40 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) {
      big[i] = i % 251;
    }
    shared.fs.writeFile("/big", big, WRITE, 0o644);
    expect(shared.memory.buffer.byteLength).toBeGreaterThanOrEqual(before + big.length);
    // Compared whole, not element by element: 40 MiB is too slow for toEqual.
    expect(Buffer.compare(process.readFile("/big"), big)).toBe(0);
    const file = process.open("/big", O_RDWR, 0);
    expect(file.read(3, big.length - 4096)).toEqual(
      big.subarray(big.length - 4096, big.length - 4093),
    );
    file.close();
    expect(shared.fs.check()).toBe(0);
  });
});

describe("a path that does not exist", () => {
  it("is told apart from a link that leads nowhere, without an error", () => {
    const fs = boot().fs;
    fs.mkdir("/d", false, 0o755);
    fs.symlink("/nowhere", "/d/dangling");
    fs.symlink("/d/loop", "/d/loop");
    fs.writeFile("/d/file", encoder.encode("x"), WRITE, 0o644);
    for (const path of ["/d/dangling", "/d/loop", "/d/loop/below"]) {
      expect(fs.exists(path)).toBe(false);
      expect(fs.isBrokenLink(path)).toBe(true);
    }
    for (const path of ["/d/missing", "/missing/too", "/d/file/below", "x".repeat(70_000)]) {
      expect(fs.exists(path)).toBe(false);
      expect(fs.isBrokenLink(path)).toBe(false);
    }
  });
});

describe("arguments", () => {
  it("raises ENAMETOOLONG when the paths do not fit the argument area", () => {
    const { fs } = boot();
    const long = `/${"a".repeat(ARGS_CAPACITY)}`;
    expect(failure(() => fs.stat(long, true))).toMatchObject({
      code: "ENAMETOOLONG",
      syscall: "stat",
      path: long,
    });
    const half = `/${"b".repeat(ARGS_CAPACITY / 2)}`;
    expect(failure(() => fs.rename(half, half))).toMatchObject({
      code: "ENAMETOOLONG",
      syscall: "rename",
      path: half,
      dest: half,
    });
    expect(fs.exists(long)).toBe(false);
    // A path that just fits is an ordinary path.
    const fits = `/${"c".repeat(ARGS_CAPACITY - 1)}`;
    expect(failure(() => fs.stat(fits, true))).toMatchObject({ code: "ENOENT", path: fits });
  });

  it("names the caller's own strings in its errors", () => {
    const { fs } = boot();
    expect(failure(() => fs.rename("/é/../x", "//y/"))).toEqual({
      code: "ENOENT",
      syscall: "rename",
      path: "/é/../x",
      dest: "//y/",
      message: "ENOENT: no such file or directory, rename '/é/../x' -> '//y/'",
    });
  });
});

describe("open files", () => {
  it("keeps a closed file closed after the module reuses its number", () => {
    const { fs } = boot();
    const first = fs.open("/a", O_RDWR | O_CREAT, 0o644);
    first.close();
    const second = fs.open("/b", O_RDWR | O_CREAT, 0o644);
    expect(failure(() => first.write(encoder.encode("x"), null))).toMatchObject({
      code: "EBADF",
      syscall: "write",
    });
    expect(second.write(encoder.encode("b"), null)).toBe(1);
    second.close();
    expect(decoder.decode(fs.readFile("/a"))).toBe("");
    expect(decoder.decode(fs.readFile("/b"))).toBe("b");
  });

  it("reports the flags it was opened with, unconverted", () => {
    const { fs } = boot();
    const flags = 2 ** 32 + (O_RDWR | O_CREAT | O_APPEND);
    const file = fs.open("/f", flags, 0o644);
    expect(file.flags).toBe(flags);
    file.write(encoder.encode("ab"), 0);
    file.write(encoder.encode("c"), 0);
    expect(decoder.decode(file.read(10, 0))).toBe("abc");
    file.close();
  });
});

describe("events", () => {
  it("are left by a process and delivered by the kernel, in order", () => {
    const shared = boot();
    const process = join(shared);
    const events: VfsWatchEvent[] = [];
    const stop = shared.fs.watch("/", true, (event) => events.push(event));
    process.mkdir("/d", false, 0o777);
    expect(process.takeEventsPending()).toBe(true);
    process.writeFile("/d/f", encoder.encode("x"), WRITE, 0o644);
    // The log was not empty: the kernel has been told already.
    expect(process.takeEventsPending()).toBe(false);
    expect(events).toEqual([]);
    shared.fs.drainEvents();
    expect(events).toEqual([
      { eventType: "rename", path: "/d" },
      { eventType: "rename", path: "/d/f" },
      { eventType: "change", path: "/d/f" },
    ]);
    process.unlink("/d/f");
    expect(process.takeEventsPending()).toBe(true);
    // The kernel's own call drains what the process left.
    shared.fs.stat("/", true);
    expect(events.at(-1)).toEqual({ eventType: "rename", path: "/d/f" });
    stop();
    process.rmdir("/d");
    expect(process.takeEventsPending()).toBe(false);
  });

  it("are logged only while a watch exists", () => {
    const shared = boot();
    const process = join(shared);
    const stopA = shared.fs.watch("/", false, () => {});
    const stopB = shared.fs.watch("/", false, () => {});
    stopA();
    stopA();
    process.mkdir("/a", false, 0o777);
    expect(process.takeEventsPending()).toBe(true);
    shared.fs.drainEvents();
    stopB();
    process.mkdir("/b", false, 0o777);
    expect(process.takeEventsPending()).toBe(false);
  });

  it("tell every watch when the log overflowed and lost some", () => {
    const shared = boot();
    const process = join(shared);
    shared.fs.mkdir("/watched", false, 0o777);
    const events: VfsWatchEvent[] = [];
    shared.fs.watch("/watched", false, (event) => events.push(event));
    const name = `/watched/${"n".repeat(16 * 1024)}`;
    const data = encoder.encode("x");
    // Two change events of 16 KiB a write (the truncation, the data): 64 MiB of them fills the log.
    for (let i = 0; i < 2100; i++) {
      process.writeFile(name, data, WRITE, 0o644);
    }
    shared.fs.drainEvents();
    expect(events.length).toBeLessThan(2 * 2100);
    expect(events.at(-1)).toEqual({ eventType: "rename", path: "/watched" });
    events.length = 0;
    process.writeFile(name, data, WRITE, 0o644);
    shared.fs.drainEvents();
    expect(events).toEqual([
      { eventType: "change", path: name },
      { eventType: "change", path: name },
    ]);
  });

  it("are handed on when the binding itself fails after the module made the change", () => {
    const shared = boot();
    const process = join(shared);
    const events: VfsWatchEvent[] = [];
    shared.fs.watch("/", false, (event) => events.push(event));
    // The module makes the file and says where its bytes go; copying them in
    // then fails in JavaScript, on data that cannot be read.
    const unreadable = {
      length: 4,
      get 0(): number {
        throw new Error("unreadable");
      },
    } as unknown as Uint8Array;
    expect(() => process.writeFile("/made", unreadable, WRITE, 0o644)).toThrow("unreadable");
    // Not a trap: the tree is whole, and the file is there.
    expect(process.stat("/made", true).size).toBe(4);
    expect(shared.fs.check()).toBe(0);
    // The kernel is still told, and the watcher hears of the new file.
    expect(process.takeEventsPending()).toBe(true);
    shared.fs.drainEvents();
    expect(events[0]).toEqual({ eventType: "rename", path: "/made" });
  });

  it("are watched only through the kernel's instance", () => {
    const process = join(boot());
    expect(() => process.watch("/", false, () => {})).toThrow(/delivers events/);
    expect(() => process.drainEvents()).toThrow(/delivers events/);
  });
});

describe("boot", () => {
  it("reads the kernel's clock", () => {
    let time = 5;
    const { fs } = boot(() => time);
    time = 9;
    fs.mkdir("/d", false, 0o777);
    expect(fs.stat("/", true).birthtimeMs).toBe(5);
    expect(fs.stat("/d", true).birthtimeMs).toBe(9);
  });

  it("admits a process per slot with a fresh token, until none is free", () => {
    const shared = boot();
    const words = new Int32Array(shared.memory.buffer);
    const slots = (shared.fs.base + OFFSET.slots) / 4;
    const entries = Array.from({ length: PROCESS_SLOTS }, () => shared.admit());
    const tokens = new Set(entries.map((entry) => entry?.token));
    const admitted = entries.map((entry) => entry?.slot ?? -1);
    expect(tokens.has(undefined)).toBe(false);
    expect(tokens.has(0)).toBe(false);
    expect(tokens.size).toBe(PROCESS_SLOTS);
    expect(new Set(admitted).size).toBe(PROCESS_SLOTS);
    expect(entries.every((entry) => words[slots + (entry?.slot ?? 0)] === entry?.token)).toBe(true);
    expect(shared.admit()).toBeNull();
    let terminated = 0;
    shared.retire(admitted[7], () => {
      // The slot is cleared first, so the process can no longer enter.
      expect(words[slots + admitted[7]]).toBe(0);
      terminated++;
    });
    expect(terminated).toBe(1);
    const again = shared.admit();
    expect(again?.slot).toBe(admitted[7]);
    expect(tokens.has(again?.token ?? 0)).toBe(false);
  });

  it("marks a process's slot as inside a call only during the call", () => {
    const shared = boot();
    const entry = shared.admit() ?? { slot: 0, token: 0 };
    const words = new Int32Array(shared.memory.buffer);
    const index = (shared.fs.base + OFFSET.slots) / 4 + entry.slot;
    const seen: number[] = [];
    // The module reads the clock in the middle of the call.
    const process = new SharedFs({
      module: shared.module,
      memory: shared.memory,
      now: () => {
        seen.push(words[index]);
        return 1;
      },
      entry,
      deliversEvents: false,
    });
    process.mkdir("/d", false, 0o777);
    expect(seen).toEqual([-entry.token]);
    expect(words[index]).toBe(entry.token);
  });

  it("clears the slot even when terminating throws", () => {
    const shared = boot();
    const entry = shared.admit();
    const words = new Int32Array(shared.memory.buffer);
    expect(() =>
      shared.retire(entry?.slot ?? 0, () => {
        throw new Error("terminate failed");
      }),
    ).toThrow("terminate failed");
    expect(words[(shared.fs.base + OFFSET.slots) / 4 + (entry?.slot ?? 0)]).toBe(0);
    expect(shared.fs.exists("/")).toBe(true);
  });

  it("returns null where there is no shared memory", () => {
    vi.stubGlobal("SharedArrayBuffer", undefined);
    expect(createSharedFilesystem()).toBeNull();
  });

  it("returns null where no memory size is accepted", () => {
    vi.spyOn(WebAssembly, "Memory").mockImplementation(function refuse() {
      throw new RangeError("could not reserve");
    });
    expect(createSharedFilesystem()).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("retiring a worker that never leaves its call", () => {
  it("gives the filesystem up instead of waiting for ever", () => {
    const shared = createSharedFilesystem({ retireTimeoutMs: 50 });
    if (shared === null) {
      throw new Error("no shared memory in this environment");
    }
    shared.fs.mkdir("/work", true, 0o755);
    const words = new Int32Array(shared.memory.buffer);
    const admission = shared.admit();
    if (admission === null) {
      throw new Error("no slot");
    }
    // A worker that entered a call, took the lock, and will never come back.
    const slot = (shared.fs.base + OFFSET.slots) / 4 + admission.slot;
    const lock = (shared.fs.base + OFFSET.lock) / 4;
    Atomics.store(words, slot, -admission.token);
    Atomics.store(words, lock, 1);

    let terminated = false;
    const started = Date.now();
    expect(shared.retire(admission.slot, () => (terminated = true))).toBe("abandoned");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(terminated).toBe(true);

    // Nothing waits on the dead worker's lock: every call fails at once.
    expect(Atomics.load(words, lock)).toBe(0);
    expect(() => shared.fs.stat("/work", true)).toThrow(/EIO/);
    // The slot is free for the next process.
    expect(Atomics.load(words, slot)).toBe(0);
  });
});

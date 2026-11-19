// @vitest-environment node
// The kernel's entries for large modules: made once from the file's own
// bytes, named by them, kept by the store and taken from it on a later visit.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PREPARED_DIR,
  PREPARED_MIN_BYTES,
  decodePreparedEntry,
  encodePreparedEntry,
} from "../process/loader/preparedEntry";
import { prepareSource, transformReady } from "../process/loader/transform";
import type { KernelEvent, PrepareRequest } from "../protocol";
import { PagePreparedStore, PreparedModules, prepareInWorker } from "./preparedModules";
import type { EntryMaker, PrepareWorker, PreparedStore } from "./preparedModules";
import { O_CREAT, O_TRUNC, O_WRONLY } from "./vfs/types";
import { Vfs } from "./vfs/vfs";

beforeAll(async () => {
  await transformReady;
});

afterEach(() => {
  vi.useRealTimers();
});

const text = (value: string) => new TextEncoder().encode(value);

/** A large ES module that exports `value`. */
function largeModule(value: string): string {
  const body = `import fs from "node:fs";\nexport const value = ${JSON.stringify(value)};\nexport default fs;\n`;
  return body + `// ${"x".repeat(PREPARED_MIN_BYTES)}\n`;
}

function write(vfs: Vfs, path: string, data: string): void {
  vfs.privileged.mkdir(path.slice(0, path.lastIndexOf("/")), true, 0o755);
  vfs.privileged.writeFile(path, text(data), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
}

/** A store that keeps what it is given, and says what it was asked. */
class KeptEntries implements PreparedStore {
  readonly entries = new Map<string, Uint8Array>();
  readonly asked: string[] = [];
  readonly kept: string[] = [];
  get(key: string): Promise<Uint8Array | null> {
    this.asked.push(key);
    return Promise.resolve(this.entries.get(key) ?? null);
  }
  put(key: string, entry: Uint8Array): void {
    this.kept.push(key);
    this.entries.set(key, entry);
  }
}

const FILE = "/home/projects/app/node_modules/large/index.mjs";

const entryOf = (filename: string, source: Uint8Array) =>
  encodePreparedEntry(prepareSource(new TextDecoder().decode(source), filename, "esm"));

/** A worker whose Rust rewriter takes every module: an entry whenever asked. */
const rewrites: EntryMaker["make"] = (filename, source) =>
  Promise.resolve(entryOf(filename, source));

/** A worker whose Rust rewriter declines every module: an entry only where sucrase may make it. */
const declines: EntryMaker["make"] = (filename, source, fallback) =>
  Promise.resolve(fallback ? entryOf(filename, source) : null);

/** A session: a filesystem with `source` at FILE, and its entries. */
function session(source: string, store: PreparedStore | null, make = rewrites, makeAfterMs = 0) {
  const vfs = new Vfs();
  write(vfs, FILE, source);
  const maker = { make: vi.fn<EntryMaker["make"]>(make), stop: vi.fn<() => void>() };
  return { vfs, maker, modules: new PreparedModules(vfs.privileged, store, maker, makeAfterMs) };
}

/** The entry of `file` once the kernel has one: asked about until it does. */
async function made(modules: PreparedModules, file = FILE): Promise<string> {
  let path: string | null = null;
  await vi.waitFor(async () => {
    path = await modules.locate(file);
    expect(path).not.toBeNull();
  });
  return path!;
}

const keyOf = (path: string) => path.slice(PREPARED_DIR.length + 1);

describe("the entry of a large module", () => {
  it("is made at once from the file, named by its source, and handed to the store", async () => {
    const store = new KeptEntries();
    const { vfs, maker, modules } = session(largeModule("one"), store);
    const path = (await modules.locate(FILE))!;
    expect(path).toMatch(new RegExp(`^${PREPARED_DIR}/[0-9a-f]{64}$`));
    const entry = vfs.privileged.readFile(path);
    expect(decodePreparedEntry(entry)).toEqual(prepareSource(largeModule("one"), FILE, "esm"));
    expect(store.asked).toEqual([keyOf(path)]);
    expect(store.kept).toEqual([keyOf(path)]);
    expect(store.entries.get(keyOf(path))).toEqual(entry);
    // Only the rewriter that costs the starting processes nothing was asked.
    expect(maker.make.mock.calls.map(([, , fallback]) => fallback)).toEqual([false]);
  });

  it("is not there at first for a module the rewriter declines, and is made a while later", async () => {
    const store = new KeptEntries();
    const { vfs, maker, modules } = session(largeModule("one"), store, declines);
    expect(await modules.locate(FILE)).toBeNull();
    const path = await made(modules);
    expect(decodePreparedEntry(vfs.privileged.readFile(path))).toEqual(
      prepareSource(largeModule("one"), FILE, "esm"),
    );
    expect(store.kept).toEqual([keyOf(path)]);
    expect(maker.make.mock.calls.map(([, , fallback]) => fallback)).toEqual([false, true]);
  });

  it("that one is made a while after the last module was asked for, not the first", async () => {
    vi.useFakeTimers();
    const store = new KeptEntries();
    const { vfs, modules } = session(largeModule("one"), store, declines, 1000);
    const second = "/home/projects/app/node_modules/second/index.mjs";
    write(vfs, second, largeModule("two"));
    expect(await modules.locate(FILE)).toBeNull();
    await vi.advanceTimersByTimeAsync(900);
    expect(await modules.locate(second)).toBeNull();
    await vi.advanceTimersByTimeAsync(900);
    expect(store.kept).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(store.kept).toHaveLength(2));
  });

  it("is found again in the session without the file being read or the store asked", async () => {
    const store = new KeptEntries();
    const { vfs, modules } = session(largeModule("one"), store);
    const first = await modules.locate(FILE);
    const read = vi.spyOn(vfs.privileged, "readFile");
    expect(await modules.locate(FILE)).toBe(first);
    expect(read).not.toHaveBeenCalled();
    expect(store.asked).toHaveLength(1);
  });

  it("is taken from the store on a later visit, nothing rewritten", async () => {
    const store = new KeptEntries();
    const path = (await session(largeModule("one"), store).modules.locate(FILE))!;
    // What the store kept is what a later session runs: marked, to tell it from a rewrite.
    const kept = encodePreparedEntry({
      ...decodePreparedEntry(store.entries.get(keyOf(path))!)!,
      code: "/* kept */",
    });
    store.entries.set(keyOf(path), kept);

    const later = session(largeModule("one"), store);
    expect(await later.modules.locate(FILE)).toBe(path);
    expect(later.vfs.privileged.readFile(path)).toEqual(kept);
    expect(later.maker.make).not.toHaveBeenCalled();
    expect(store.kept).toEqual([keyOf(path)]);
  });

  it("is another entry for another source, and for the same source elsewhere", async () => {
    const one = await session(largeModule("one"), new KeptEntries()).modules.locate(FILE);
    const two = await session(largeModule("two"), new KeptEntries()).modules.locate(FILE);
    expect(two).not.toBe(one);

    const { vfs, modules } = session(largeModule("one"), new KeptEntries());
    const elsewhere = "/home/projects/app/node_modules/other/index.mjs";
    write(vfs, elsewhere, largeModule("one"));
    expect(await modules.locate(FILE)).toBe(one);
    expect(await modules.locate(elsewhere)).not.toBe(one);
  });

  it("follows the file when it is written again", async () => {
    const { vfs, modules } = session(largeModule("one"), new KeptEntries());
    const first = await modules.locate(FILE);
    write(vfs, FILE, largeModule("another, and longer"));
    const second = (await modules.locate(FILE))!;
    expect(second).not.toBe(first);
    expect(decodePreparedEntry(vfs.privileged.readFile(second))).toEqual(
      prepareSource(largeModule("another, and longer"), FILE, "esm"),
    );
  });

  it("is not made later of a file that changed since it was asked about", async () => {
    vi.useFakeTimers();
    const store = new KeptEntries();
    const { vfs, modules } = session(largeModule("one"), store, declines, 1000);
    expect(await modules.locate(FILE)).toBeNull();
    write(vfs, FILE, largeModule("changed, and longer"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.kept).toEqual([]);
    expect(vfs.privileged.exists(PREPARED_DIR)).toBe(false);
  });

  it("is made anew when what the store kept is no entry", async () => {
    const store = new KeptEntries();
    const path = (await session(largeModule("one"), store).modules.locate(FILE))!;
    store.entries.set(keyOf(path), text("spoiled"));

    const later = session(largeModule("one"), store);
    expect(await later.modules.locate(FILE)).toBe(path);
    expect(decodePreparedEntry(later.vfs.privileged.readFile(path))).toEqual(
      prepareSource(largeModule("one"), FILE, "esm"),
    );
    expect(store.kept).toEqual([keyOf(path), keyOf(path)]);
  });

  it("is not made of a source nothing rewrites, or by a worker that answers with no entry", async () => {
    vi.useFakeTimers();
    for (const answer of [null, text("no entry")]) {
      const store = new KeptEntries();
      const { vfs, modules } = session(
        largeModule("one"),
        store,
        () => Promise.resolve(answer),
        1000,
      );
      expect(await modules.locate(FILE)).toBeNull();
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.kept).toEqual([]);
      expect(vfs.privileged.exists(PREPARED_DIR)).toBe(false);
      expect(await modules.locate(FILE)).toBeNull();
    }
  });

  it("is no longer made once the kernel is gone", async () => {
    vi.useFakeTimers();
    const store = new KeptEntries();
    const { modules, maker } = session(largeModule("one"), store, declines, 1000);
    expect(await modules.locate(FILE)).toBeNull();
    modules.dispose();
    expect(maker.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.kept).toEqual([]);
  });
});

describe("a file that gets no entry", () => {
  it("is answered at once: a small file, a project's own, a directory, a missing one", () => {
    const { vfs, modules } = session(largeModule("one"), new KeptEntries());
    write(vfs, "/home/projects/app/node_modules/small/index.mjs", "export const a = 1;\n");
    write(vfs, "/home/projects/app/src/own.mjs", largeModule("own"));
    expect(modules.locate("/home/projects/app/node_modules/small/index.mjs")).toBeNull();
    expect(modules.locate("/home/projects/app/src/own.mjs")).toBeNull();
    expect(modules.locate("/home/projects/app/node_modules/large")).toBeNull();
    expect(modules.locate("/home/projects/app/node_modules/large/missing.mjs")).toBeNull();
  });

  it("is every file where nothing is kept between visits", () => {
    const { vfs, maker, modules } = session(largeModule("one"), null);
    const read = vi.spyOn(vfs.privileged, "readFile");
    expect(modules.locate(FILE)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(maker.make).not.toHaveBeenCalled();
  });
});

describe("the worker entries are made in", () => {
  /** A worker that records what it is sent and how it ends. */
  function fakeWorker() {
    const sent: PrepareRequest[] = [];
    const worker: PrepareWorker & { ended: boolean } = {
      ended: false,
      postMessage(message) {
        sent.push(message);
      },
      terminate() {
        worker.ended = true;
      },
      onmessage: null,
      onerror: null,
    };
    const answer = (entry: Uint8Array | null) =>
      worker.onmessage!({ data: { type: "prepared", entry } } as MessageEvent);
    return { worker, sent, answer };
  }

  it("is started for the first module and ended soon after the last the rewriter made", async () => {
    vi.useFakeTimers();
    const { worker, sent, answer } = fakeWorker();
    const start = vi.fn<() => PrepareWorker>(() => worker);
    const maker = prepareInWorker(start);
    const first = maker.make(FILE, text("export const a = 1;"), false);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      { type: "prepare", filename: FILE, source: text("export const a = 1;"), fallback: false },
    ]);
    answer(text("entry"));
    expect(await first).toEqual(text("entry"));

    // The next one within the second: the same worker.
    await vi.advanceTimersByTimeAsync(500);
    const second = maker.make("/other.mjs", text("export const b = 2;"), false);
    await vi.advanceTimersByTimeAsync(0);
    answer(text("another"));
    expect(await second).toEqual(text("another"));
    expect(start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(worker.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.ended).toBe(true);
  });

  it("stays long enough for its heap to shrink after an entry sucrase made", async () => {
    vi.useFakeTimers();
    const { worker, sent, answer } = fakeWorker();
    const made = prepareInWorker(() => worker).make(FILE, text("x"), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0].fallback).toBe(true);
    answer(text("entry"));
    await made;
    await vi.advanceTimersByTimeAsync(44_000);
    expect(worker.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.ended).toBe(true);
  });

  it("makes one entry at a time", async () => {
    vi.useFakeTimers();
    const { worker, sent, answer } = fakeWorker();
    const maker = prepareInWorker(() => worker);
    const first = maker.make(FILE, text("a"), false);
    const second = maker.make("/other.mjs", text("b"), false);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    answer(text("one"));
    expect(await first).toEqual(text("one"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    answer(text("two"));
    expect(await second).toEqual(text("two"));
  });

  it("gives no entry, and is ended at once, when it fails, takes too long or is stopped", async () => {
    vi.useFakeTimers();
    const failing = fakeWorker();
    const failed = prepareInWorker(() => failing.worker).make(FILE, text("x"), false);
    await vi.advanceTimersByTimeAsync(0);
    failing.worker.onerror!({ preventDefault() {} } as ErrorEvent);
    expect(await failed).toBeNull();
    expect(failing.worker.ended).toBe(true);

    const silent = fakeWorker();
    const late = prepareInWorker(() => silent.worker).make(FILE, text("x"), false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await late).toBeNull();
    expect(silent.worker.ended).toBe(true);

    const stopped = fakeWorker();
    const maker = prepareInWorker(() => stopped.worker);
    const made = maker.make(FILE, text("x"), false);
    await vi.advanceTimersByTimeAsync(0);
    stopped.answer(text("entry"));
    await made;
    maker.stop();
    expect(stopped.worker.ended).toBe(true);
  });

  it("gives no entry where no worker can be started", async () => {
    expect(await prepareInWorker(() => null).make(FILE, text("x"), false)).toBeNull();
  });
});

describe("the page's store, from the kernel", () => {
  const started = () => {
    const events: KernelEvent[] = [];
    return { events, store: new PagePreparedStore((event) => events.push(event), "1.abc") };
  };

  it("asks the page for an entry of this build's version and takes its answer", async () => {
    const { events, store } = started();
    const found = store.get("key-1");
    const missing = store.get("key-2");
    expect(events).toEqual([
      { event: "prepared-get", ask: 1, version: "1.abc", key: "key-1" },
      { event: "prepared-get", ask: 2, version: "1.abc", key: "key-2" },
    ]);
    store.answer(2, null);
    store.answer(1, text("entry"));
    expect(await found).toEqual(text("entry"));
    expect(await missing).toBeNull();
  });

  it("goes on without an entry when the page does not answer", async () => {
    vi.useFakeTimers();
    const { store } = started();
    const found = store.get("key");
    vi.advanceTimersByTime(1500);
    expect(await found).toBeNull();
    // A late answer is nobody's.
    store.answer(1, text("late"));
  });

  it("hands the page an entry to keep", () => {
    const { events, store } = started();
    store.put("key", text("entry"));
    expect(events).toEqual([
      { event: "prepared-put", version: "1.abc", key: "key", entry: text("entry") },
    ]);
  });
});

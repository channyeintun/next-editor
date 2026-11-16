// Watching: `fs.watch` → `FSWatcher` (change notifications from the kernel's
// filesystem), `fs.watchFile`/`unwatchFile` → `StatWatcher` (stat polling, the
// way libuv's fs_poll compares records), and `fs.promises.watch` (an async
// iterator). A watcher that keeps the process alive holds one `runtime().ref()`
// until it is closed or unref'd. Events are delivered asynchronously.
import EventEmitter from "../events";
import type { EventEmitter as EventEmitterType } from "../events";
import {
  AbortError,
  makeNodeError,
  validateAbortSignal,
  validateBoolean,
  validateFunction,
  validateObject,
  invalidArgValue,
} from "../internalErrors";
import { Buffer } from "../buffer";
import path from "../path";
import { errnoOf, type ErrnoCode } from "../../../errors";
import type { StatData } from "../../../kernel/vfs/types";
import { runtime } from "../../runtime";
import { encodeText, getOptions, getValidatedPath, toAbsolute } from "./args";
import { restate } from "./errors";
import { makeStats, ZERO_STAT } from "./stats";

// Native timers, taken before any process code can replace the globals: a
// poll must not count as a pending timer of the process.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

const EmitterBase = EventEmitter as unknown as new () => EventEmitterType;

type ChangeListener = (eventType: "rename" | "change", filename: string) => void;

/** Starts a backend watch on `shown`, restating a failure as Node's `watch` error with `filename`. */
function startWatch(shown: string, recursive: boolean, listener: ChangeListener): () => void {
  const absolute = toAbsolute(shown);
  try {
    return runtime().fs.watch(absolute, recursive, listener);
  } catch (error) {
    const restated = restate(error, { absolute, shown, syscall: "watch" }) as Error & {
      filename?: string;
    };
    restated.filename = shown;
    throw restated;
  }
}

/** `fs.FSWatcher`. */
export class FSWatcher extends EmitterBase {
  #stop: (() => void) | null = null;
  #refed = false;

  /** @internal Starts watching; `fs.watch` calls it. */
  start(filename: unknown, persistent: boolean, recursive: boolean, encoding: unknown): void {
    const shown = getValidatedPath(filename, "filename");
    this.#stop = startWatch(shown, recursive, (eventType, name) => {
      queueMicrotask(() => {
        if (this.#stop !== null) {
          this.emit("change", eventType, encodeText(name, encoding));
        }
      });
    });
    if (persistent) {
      this.ref();
    }
  }

  /** Stops watching; `close` is emitted on the next tick. */
  close(): void {
    if (this.#stop === null) {
      return;
    }
    this.#stop();
    this.#stop = null;
    this.unref();
    queueMicrotask(() => this.emit("close"));
  }

  /** Keeps the process alive while the watcher is open. */
  ref(): this {
    if (this.#stop !== null && !this.#refed) {
      this.#refed = true;
      runtime().ref();
    }
    return this;
  }

  /** Lets the process exit while the watcher is open. */
  unref(): this {
    if (this.#refed) {
      this.#refed = false;
      runtime().unref();
    }
    return this;
  }
}

/** `fs.watch(filename, options | encoding, listener)`. */
export function watch(filename: unknown, options?: unknown, listener?: unknown): FSWatcher {
  let callback = listener;
  if (typeof options === "function") {
    callback = options;
  }
  const opts = { ...getOptions(options) } as {
    persistent?: unknown;
    recursive?: unknown;
    encoding?: unknown;
    signal?: AbortSignal;
  };
  if (opts.persistent === undefined) {
    opts.persistent = true;
  }
  if (opts.recursive === undefined) {
    opts.recursive = false;
  }
  const watcher = new FSWatcher();
  watcher.start(filename, Boolean(opts.persistent), Boolean(opts.recursive), opts.encoding);
  if (typeof callback === "function") {
    watcher.addListener("change", callback as ChangeListener);
  }
  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) {
      queueMicrotask(() => watcher.close());
    } else {
      const onAbort = () => watcher.close();
      signal.addEventListener("abort", onAbort);
      watcher.once("close", () => signal.removeEventListener("abort", onAbort));
    }
  }
  return watcher;
}

function statsEqual(a: StatData, b: StatData): boolean {
  return (
    a.ctimeMs === b.ctimeMs &&
    a.mtimeMs === b.mtimeMs &&
    a.birthtimeMs === b.birthtimeMs &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

/** `fs.StatWatcher`: polls one path with `stat` and emits `change(current, previous)`. */
export class StatWatcher extends EmitterBase {
  #bigint: boolean;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #active = false;
  #refs = 0;
  #refed = false;
  /** libuv's `busy_polling`: 0 before the first poll, 1 after a success, the negative errno after a failure. */
  #status = 0;
  #last: StatData = ZERO_STAT;
  #oldStatus = -1;

  constructor(bigint: boolean) {
    super();
    this.#bigint = bigint;
  }

  /** @internal Starts polling `absolute` every `interval` ms. */
  start(absolute: string, persistent: boolean, interval: number): void {
    if (this.#active) {
      return;
    }
    this.#active = true;
    this.#refs = persistent ? 1 : 0;
    this.#syncRef();
    const poll = () => {
      if (!this.#active) {
        return;
      }
      this.#poll(absolute);
      if (this.#active) {
        this.#timer = nativeSetTimeout(poll, interval);
      }
    };
    // The first stat runs asynchronously too, as libuv's does, so listeners
    // added right after `watchFile` returns see its result.
    this.#timer = nativeSetTimeout(poll, 0);
  }

  /** Stops polling; `stop` is emitted on the next tick. */
  stop(): void {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    if (this.#timer !== null) {
      nativeClearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#refs = 0;
    this.#syncRef();
    queueMicrotask(() => this.emit("stop"));
  }

  ref(): this {
    if (this.#refs > 0) {
      return this;
    }
    if (this.#active) {
      this.#refs++;
      this.#syncRef();
    }
    return this;
  }

  unref(): this {
    if (this.#active && this.#refs > 0) {
      this.#refs--;
      this.#syncRef();
    }
    return this;
  }

  /** @internal `watchFile` adds a listener ("add"), `unwatchFile` removes one ("clean") or all ("cleanAll"). */
  addOrCleanRef(operation: "add" | "clean" | "cleanAll"): void {
    if (operation === "add") {
      this.#refs++;
    } else if (operation === "clean") {
      this.unref();
      return;
    } else {
      this.#refs = 0;
    }
    this.#syncRef();
  }

  #syncRef(): void {
    const want = this.#active && this.#refs > 0;
    if (want && !this.#refed) {
      this.#refed = true;
      runtime().ref();
    } else if (!want && this.#refed) {
      this.#refed = false;
      runtime().unref();
    }
  }

  #poll(absolute: string): void {
    let current: StatData;
    try {
      current = runtime().fs.stat(absolute, true);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = code === undefined ? -1 : -errnoOf(code as ErrnoCode);
      if (this.#status !== status) {
        this.#status = status;
        this.#report(status, ZERO_STAT, this.#last);
      }
      return;
    }
    if (this.#status !== 0 && (this.#status < 0 || !statsEqual(this.#last, current))) {
      this.#report(0, current, this.#last);
    }
    this.#last = current;
    this.#status = 1;
  }

  #report(status: number, current: StatData, previous: StatData): void {
    // Node skips a repeated failure that changed nothing (lib/internal/fs/watchers.js).
    if (this.#oldStatus === -1 && status === -1 && current.nlink === previous.nlink) {
      return;
    }
    this.#oldStatus = status;
    this.emit("change", makeStats(current, this.#bigint), makeStats(previous, this.#bigint));
  }
}

const statWatchers = new Map<string, StatWatcher>();

/** `fs.watchFile(filename, { persistent, interval, bigint }, listener)`. */
export function watchFile(filename: unknown, options?: unknown, listener?: unknown): StatWatcher {
  const resolved = path.resolve(getValidatedPath(filename));
  let callback = listener;
  let opts: unknown = options;
  if (opts === null || typeof opts !== "object") {
    callback = opts;
    opts = null;
  }
  const merged = { interval: 5007, persistent: true, ...(opts as object | null) } as {
    interval: number;
    persistent: boolean;
    bigint?: boolean;
  };
  validateFunction(callback, "listener");
  let watcher = statWatchers.get(resolved);
  if (watcher === undefined) {
    watcher = new StatWatcher(Boolean(merged.bigint));
    watcher.start(resolved, merged.persistent, merged.interval);
    statWatchers.set(resolved, watcher);
  } else {
    watcher.addOrCleanRef("add");
  }
  watcher.addListener("change", callback as (...args: unknown[]) => void);
  return watcher;
}

/** `fs.unwatchFile(filename, listener)`. */
export function unwatchFile(filename: unknown, listener?: unknown): void {
  const resolved = path.resolve(getValidatedPath(filename));
  const watcher = statWatchers.get(resolved);
  if (watcher === undefined) {
    return;
  }
  if (typeof listener === "function") {
    const before = watcher.listenerCount("change");
    watcher.removeListener("change", listener as (...args: unknown[]) => void);
    if (watcher.listenerCount("change") < before) {
      watcher.addOrCleanRef("clean");
    }
  } else {
    watcher.removeAllListeners("change");
    watcher.addOrCleanRef("cleanAll");
  }
  if (watcher.listenerCount("change") === 0) {
    watcher.stop();
    statWatchers.delete(resolved);
  }
}

/** One event of `fs.promises.watch`. */
export interface WatchEvent {
  eventType: "rename" | "change";
  filename: string | Buffer;
}

/** `fs.promises.watch(filename, { persistent, recursive, encoding, signal, maxQueue, overflow })`. */
export async function* watchAsync(
  filename: unknown,
  options: unknown = {},
): AsyncGenerator<WatchEvent, void, undefined> {
  const shown = getValidatedPath(filename);
  validateObject(options, "options");
  const {
    persistent = true,
    recursive = false,
    encoding = "utf8",
    signal,
    maxQueue = 2048,
    overflow = "ignore",
  } = options as {
    persistent?: unknown;
    recursive?: unknown;
    encoding?: unknown;
    signal?: AbortSignal;
    maxQueue?: unknown;
    overflow?: unknown;
  };
  validateBoolean(persistent, "options.persistent");
  validateBoolean(recursive, "options.recursive");
  validateAbortSignal(signal, "options.signal");
  if (encoding && !Buffer.isEncoding(encoding as string)) {
    throw invalidArgValue("encoding", encoding, "is invalid encoding");
  }
  if (overflow !== "ignore" && overflow !== "throw") {
    throw invalidArgValue("options.overflow", overflow, "must be one of: 'ignore', 'throw'");
  }
  if (signal?.aborted) {
    throw new AbortError(undefined, { cause: signal.reason });
  }
  const queue: WatchEvent[] = [];
  let wake: (() => void) | null = null;
  let failure: Error | null = null;
  const notify = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const stop = startWatch(shown, recursive, (eventType, name) => {
    if (queue.length >= (maxQueue as number)) {
      if (overflow === "throw") {
        failure = makeNodeError("ERR_FS_WATCH_QUEUE_OVERFLOW", `fs.watch maxQueue exceeded`);
        notify();
      }
      return;
    }
    queue.push({ eventType, filename: encodeText(name, encoding) });
    notify();
  });
  const onAbort = () => notify();
  signal?.addEventListener("abort", onAbort);
  if (persistent) {
    runtime().ref();
  }
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new AbortError(undefined, { cause: signal.reason });
      }
      if (failure !== null) {
        throw failure;
      }
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    stop();
    signal?.removeEventListener("abort", onAbort);
    if (persistent) {
      runtime().unref();
    }
  }
}

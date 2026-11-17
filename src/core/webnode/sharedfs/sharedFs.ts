// `SharedFs`: the filesystem contract (`VfsApi`, kernel/vfs/types.ts) over the
// Rust module on the shared memory. Every operation is one `call`: take the
// lock, run the module, copy the result out (or the caller's bytes in), and
// release. The kernel's instance also delivers watch events; a process's
// instance only says when it left some for the kernel (README.md).
import { createSystemError, type ErrnoCode } from "../errors";
import type { DirEntry, OpenFile, StatData, VfsApi, VfsWatchEvent } from "../kernel/vfs/types";
import { WatchRegistry } from "../kernel/vfs/watchers";
import {
  ARGS_CAPACITY,
  ENTRY_KINDS,
  ERRNO_CODES,
  EVENT_TYPES,
  OFFSET,
  PATH_BOTH,
  PATH_FIRST,
  SYSCALL_NAMES,
} from "./abi";
import { acquireLock, releaseLock } from "./lock";

/** The same alphabet and attempts as `Vfs.mkdtemp` (kernel/vfs/vfs.ts). */
const TEMP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TEMP_ATTEMPTS = 100;

/** The module's exports (README.md lists what each leaves in the shared block). */
interface Exports {
  fs_base(): number;
  fs_init(): number;
  fs_stat(a: number, follow: number): number;
  fs_exists(a: number): number;
  fs_readdir(a: number): number;
  fs_mkdir(a: number, recursive: number, mode: number): number;
  fs_rmdir(a: number): number;
  fs_unlink(a: number): number;
  fs_rm(a: number, recursive: number, force: number): number;
  fs_rename(a: number, b: number): number;
  fs_link(a: number, b: number): number;
  fs_copy_file(a: number, b: number, mode: number): number;
  fs_symlink(a: number, b: number): number;
  fs_readlink(a: number): number;
  fs_realpath(a: number): number;
  fs_watch_path(a: number): number;
  fs_chmod(a: number, mode: number, follow: number): number;
  fs_utimes(a: number, atime: number, mtime: number, follow: number): number;
  fs_truncate(a: number, length: number): number;
  fs_access(a: number, mode: number): number;
  fs_mkdtemp(a: number): number;
  fs_read_file(a: number): number;
  fs_write_file(a: number, flags: number, mode: number, length: number): number;
  fs_open(a: number, flags: number, mode: number): number;
  fs_handle_read(handle: number, length: number, position: number): number;
  fs_handle_write(handle: number, length: number, position: number): number;
  fs_handle_stat(handle: number): number;
  fs_handle_truncate(handle: number, length: number): number;
  fs_handle_chmod(handle: number, mode: number): number;
  fs_handle_utimes(handle: number, atime: number, mtime: number): number;
  fs_handle_close(handle: number): number;
  fs_events(): number;
  fs_events_clear(): number;
  fs_totals(): number;
  fs_check(): number;
}

export interface SharedFsOptions {
  /** The compiled filesystem module (boot.ts). */
  module: WebAssembly.Module;
  /** The one shared memory every instance runs on. */
  memory: WebAssembly.Memory;
  /** The clock the module reads for timestamps, in epoch milliseconds. */
  now: () => number;
  /** A process's slot and token (boot.ts `admit`). The kernel has none. */
  entry?: { slot: number; token: number };
  /** True for the kernel's instance: it drains the event log and calls the watchers. */
  deliversEvents: boolean;
}

/** What an open file asks of the filesystem that opened it. */
interface HandleHost {
  read(handle: number, length: number, position: number | null): Uint8Array;
  write(handle: number, data: Uint8Array, position: number | null): number;
  stat(handle: number): StatData;
  truncate(handle: number, length: number): void;
  chmod(handle: number, mode: number): void;
  utimes(handle: number, atimeMs: number, mtimeMs: number): void;
  close(handle: number): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Frames `probeStack` goes down: see `SharedFs.call`. A margin, not a
 * measured need: in 4,500 runaway recursions without any probe, V8 never
 * raised its RangeError inside the module, and each frame here costs a call.
 */
const STACK_PROBE_DEPTH = 8;

/**
 * Uses the stack a call into the module needs, and nothing else: it throws the
 * engine's RangeError when that much is not left. Each frame keeps eight
 * values alive across the call below it, so that no compiler tier can make the
 * frames smaller than the ones they stand in for.
 */
function probeStack(
  depth: number,
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
): number {
  if (depth === 0) {
    return a;
  }
  return probeStack(depth - 1, b, c, d, e, f, g, h, a) + a + b + c + d + e + f + g + h;
}

/**
 * Writes `text` as UTF-8 into `target` from `offset` and returns the byte
 * count, or -1 when it does not fit. Not `TextEncoder.encodeInto`: a browser
 * refuses to encode into a view of shared memory. A path is nearly always
 * ASCII, which is written directly; anything else is encoded into a private
 * buffer first.
 */
function writeText(text: string, target: Uint8Array, offset: number): number {
  const room = target.length - offset;
  let index = 0;
  for (; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) {
      break;
    }
    if (index >= room) {
      return -1;
    }
    target[offset + index] = code;
  }
  if (index === text.length) {
    return index;
  }
  const bytes = encoder.encode(text);
  if (bytes.length > room) {
    return -1;
  }
  target.set(bytes, offset);
  return bytes.length;
}

/** Sleeps for good: the worker is about to be terminated (README.md, Rules). */
function park(): never {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    Atomics.wait(cell, 0, 0);
  }
}

/** The filesystem on the shared memory: see the file comment. */
export class SharedFs implements VfsApi {
  /** The shared block's address (boot.ts gives out its slots). */
  readonly base: number;
  private readonly memory: WebAssembly.Memory;
  private readonly x: Exports;
  private readonly deliversEvents: boolean;
  /** The slot's word index, or -1 for the kernel, which enters without one. */
  private readonly slotIndex: number;
  private readonly token: number;
  /** Word indexes of the shared block. */
  private readonly lockIndex: number;
  private readonly poisonedIndex: number;
  private readonly watchingIndex: number;
  private readonly eventsLengthIndex: number;
  private readonly errnoIndex: number;
  private readonly syscallIndex: number;
  private readonly pathModeIndex: number;
  private readonly ptrIndex: number;
  private readonly lenIndex: number;
  private readonly auxIndex: number;
  private readonly eventsDroppedIndex: number;
  /** The shared block's words, the stat record and the argument area. They lie in the
   * static area, inside the memory's initial pages, so these views never go stale. */
  private readonly words: Int32Array;
  private readonly unsigned: Uint32Array;
  private readonly statRecord: Float64Array;
  private readonly args: Uint8Array;
  /** The whole memory. Replaced when the memory has grown past it. */
  private bytes: Uint8Array;
  private readonly watchers = new WatchRegistry();
  /** The path of every registered watch, for when the log overflowed. */
  private readonly watchedPaths = new Set<{ path: string }>();
  private readonly handleHost: HandleHost;
  private eventsPending = false;
  /** True while a function of the module is running (see the constructor). */
  private inModule = false;
  /** The error this binding is throwing on purpose; anything else thrown inside a call is a trap. */
  private failure: Error | null = null;

  constructor(options: SharedFsOptions) {
    this.memory = options.memory;
    this.deliversEvents = options.deliversEvents;
    const instance = new WebAssembly.Instance(options.module, {
      env: { memory: options.memory, now: options.now },
    });
    // Every call into the module is marked, so that `call` can tell an error
    // that escaped the module, whose state may then be torn, from one raised
    // by this binding's own JavaScript, which leaves the tree whole.
    const marked: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(instance.exports)) {
      marked[name] =
        typeof value === "function"
          ? (...args: number[]) => {
              this.inModule = true;
              const result = (value as (...args: number[]) => number)(...args);
              this.inModule = false;
              return result;
            }
          : value;
    }
    this.x = marked as unknown as Exports;
    const base = this.x.fs_base() >>> 0;
    this.base = base;
    const buffer = options.memory.buffer;
    this.words = new Int32Array(buffer);
    this.unsigned = new Uint32Array(buffer);
    this.bytes = new Uint8Array(buffer);
    this.statRecord = new Float64Array(buffer, base + OFFSET.stat, 14);
    this.args = new Uint8Array(buffer, base + OFFSET.args, ARGS_CAPACITY);
    const word = (offset: number) => (base + offset) / 4;
    this.lockIndex = word(OFFSET.lock);
    this.poisonedIndex = word(OFFSET.poisoned);
    this.watchingIndex = word(OFFSET.watching);
    this.eventsLengthIndex = word(OFFSET.eventsLength);
    this.errnoIndex = word(OFFSET.errno);
    this.syscallIndex = word(OFFSET.syscall);
    this.pathModeIndex = word(OFFSET.pathMode);
    this.ptrIndex = word(OFFSET.ptr);
    this.lenIndex = word(OFFSET.len);
    this.auxIndex = word(OFFSET.aux);
    this.eventsDroppedIndex = word(OFFSET.eventsDropped);
    this.slotIndex = options.entry === undefined ? -1 : word(OFFSET.slots) + options.entry.slot;
    this.token = options.entry?.token ?? 0;
    this.handleHost = {
      read: (handle, length, position) => this.handleRead(handle, length, position),
      write: (handle, data, position) => this.handleWrite(handle, data, position),
      stat: (handle) =>
        this.call("fstat", () => {
          this.ok(this.x.fs_handle_stat(handle));
          return this.statData();
        }),
      truncate: (handle, length) =>
        this.call("ftruncate", () => this.ok(this.x.fs_handle_truncate(handle, length))),
      chmod: (handle, mode) =>
        this.call("fchmod", () => this.ok(this.x.fs_handle_chmod(handle, mode & 0o7777))),
      utimes: (handle, atimeMs, mtimeMs) =>
        this.call("futime", () => this.ok(this.x.fs_handle_utimes(handle, atimeMs, mtimeMs))),
      close: (handle) => this.call("close", () => this.ok(this.x.fs_handle_close(handle))),
    };
  }

  /** Makes the root directory the first time any instance calls it (boot.ts does). */
  init(): void {
    this.call("mkdir", () => this.ok(this.x.fs_init()));
  }

  /** Live inodes and the bytes their files hold, for diagnostics. */
  totals(): { inodes: number; bytes: number } {
    return this.call("stat", () => {
      this.ok(this.x.fs_totals());
      return { inodes: this.statRecord[0], bytes: this.statRecord[1] };
    });
  }

  /** 0 when the heap and the tree are consistent, -1 when not, 1 when there was no memory to look. */
  check(): number {
    return this.call("stat", () => this.x.fs_check());
  }

  /**
   * Whether a call since the last time this was asked left the kernel
   * something to deliver where there was nothing before it (events in the
   * log, or the mark that some were lost), and so the kernel must be told.
   * Resets it.
   */
  takeEventsPending(): boolean {
    const pending = this.eventsPending;
    this.eventsPending = false;
    return pending;
  }

  /** Delivers what processes left in the event log (the kernel's instance only). */
  drainEvents(): void {
    this.requireDelivery();
    this.call("watch", () => 0);
  }

  stat(path: string, followSymlinks: boolean): StatData {
    const syscall = followSymlinks ? "stat" : "lstat";
    return this.call(syscall, () => {
      const a = this.putFirst(path, syscall);
      this.ok(this.x.fs_stat(a, followSymlinks ? 1 : 0), path);
      return this.statData();
    });
  }

  exists(path: string): boolean {
    return this.call("stat", () => {
      const a = writeText(path, this.args, 0);
      // Nothing in the tree has a path that long, as vfs.ts would find.
      if (a < 0) {
        return false;
      }
      return this.ok(this.x.fs_exists(a), path) === 1;
    });
  }

  /**
   * Whether a path that `exists` reports missing is a symbolic link that
   * leads nowhere or into a loop, rather than nothing at all. It raises no
   * error: a process asks this on every miss (module resolution misses far
   * more often than it hits), and making an error costs ten times the call.
   */
  isBrokenLink(path: string): boolean {
    return this.call("lstat", () => {
      const a = writeText(path, this.args, 0);
      if (a < 0) {
        return false;
      }
      if (this.x.fs_stat(a, 0) >= 0) {
        return true;
      }
      return ERRNO_CODES[this.unsigned[this.errnoIndex]] === "ELOOP";
    });
  }

  readdir(path: string): DirEntry[] {
    const entries = this.call("scandir", () => {
      const a = this.putFirst(path, "scandir");
      this.ok(this.x.fs_readdir(a), path);
      return this.parseListing(this.copyResult(), this.unsigned[this.auxIndex]);
    });
    // The order vfs.ts gives: JavaScript's default sort of the names.
    return entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  mkdir(path: string, recursive: boolean, mode: number): string | undefined {
    return this.call("mkdir", () => {
      const a = this.putFirst(path, "mkdir");
      this.ok(this.x.fs_mkdir(a, recursive ? 1 : 0, mode), path);
      return this.unsigned[this.auxIndex] === 0 ? undefined : this.resultText();
    });
  }

  rmdir(path: string): void {
    this.call("rmdir", () => this.ok(this.x.fs_rmdir(this.putFirst(path, "rmdir")), path));
  }

  unlink(path: string): void {
    this.call("unlink", () => this.ok(this.x.fs_unlink(this.putFirst(path, "unlink")), path));
  }

  rm(path: string, recursive: boolean, force: boolean): void {
    this.call("rm", () => {
      const a = this.putFirst(path, "rm");
      this.ok(this.x.fs_rm(a, recursive ? 1 : 0, force ? 1 : 0), path);
    });
  }

  rename(from: string, to: string): void {
    this.call("rename", () => {
      const a = this.putFirst(from, "rename", to);
      const b = this.putSecond(a, from, to, "rename");
      this.ok(this.x.fs_rename(a, b), from, to);
    });
  }

  link(existingPath: string, newPath: string): void {
    this.call("link", () => {
      const a = this.putFirst(existingPath, "link", newPath);
      const b = this.putSecond(a, existingPath, newPath, "link");
      this.ok(this.x.fs_link(a, b), existingPath, newPath);
    });
  }

  symlink(target: string, path: string): void {
    this.call("symlink", () => {
      const a = this.putFirst(target, "symlink", path);
      const b = this.putSecond(a, target, path, "symlink");
      this.ok(this.x.fs_symlink(a, b), target, path);
    });
  }

  readlink(path: string): string {
    return this.call("readlink", () => {
      this.ok(this.x.fs_readlink(this.putFirst(path, "readlink")), path);
      return this.resultText();
    });
  }

  realpath(path: string): string {
    return this.call("realpath", () => {
      this.ok(this.x.fs_realpath(this.putFirst(path, "realpath")), path);
      return this.resultText();
    });
  }

  chmod(path: string, mode: number, followSymlinks: boolean): void {
    this.call("chmod", () => {
      const a = this.putFirst(path, "chmod");
      // `mode & 0o7777`, as vfs.ts stores it: the module takes the reduced bits.
      this.ok(this.x.fs_chmod(a, mode & 0o7777, followSymlinks ? 1 : 0), path);
    });
  }

  utimes(path: string, atimeMs: number, mtimeMs: number, followSymlinks: boolean): void {
    this.call("utime", () => {
      const a = this.putFirst(path, "utime");
      this.ok(this.x.fs_utimes(a, atimeMs, mtimeMs, followSymlinks ? 1 : 0), path);
    });
  }

  truncate(path: string, length: number): void {
    this.call("open", () => {
      this.ok(this.x.fs_truncate(this.putFirst(path, "open"), length), path);
    });
  }

  copyFile(source: string, destination: string, mode: number): void {
    this.call("copyfile", () => {
      const a = this.putFirst(source, "copyfile", destination);
      const b = this.putSecond(a, source, destination, "copyfile");
      this.ok(this.x.fs_copy_file(a, b, mode | 0), source, destination);
    });
  }

  access(path: string, mode: number): void {
    this.call("access", () => {
      this.ok(this.x.fs_access(this.putFirst(path, "access"), mode | 0), path);
    });
  }

  mkdtemp(prefix: string): string {
    const shown = `${prefix}XXXXXX`;
    const random = new Uint8Array(6);
    for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt++) {
      crypto.getRandomValues(random);
      let path = prefix;
      for (const byte of random) {
        path += TEMP_CHARS[byte % TEMP_CHARS.length];
      }
      const made = this.call("mkdtemp", () => {
        const a = this.putFirst(path, "mkdtemp", undefined, shown);
        return this.ok(this.x.fs_mkdtemp(a), shown) === 1;
      });
      if (made) {
        return path;
      }
    }
    throw createSystemError("EEXIST", "mkdtemp", shown);
  }

  readFile(path: string): Uint8Array {
    return this.call("open", () => {
      this.ok(this.x.fs_read_file(this.putFirst(path, "open")), path);
      return this.copyResult();
    });
  }

  writeFile(path: string, data: Uint8Array, flags: number, mode: number): void {
    this.call("open", () => {
      const a = this.putFirst(path, "open");
      this.ok(this.x.fs_write_file(a, flags | 0, mode, data.length), path);
      this.copyIn(data);
    });
  }

  open(path: string, flags: number, mode: number): OpenFile {
    const handle = this.call("open", () =>
      this.ok(this.x.fs_open(this.putFirst(path, "open"), flags | 0, mode), path),
    );
    return new SharedFile(handle, flags, this.handleHost);
  }

  watch(path: string, recursive: boolean, listener: (event: VfsWatchEvent) => void): () => void {
    this.requireDelivery();
    const watched = this.call("watch", () => {
      this.ok(this.x.fs_watch_path(this.putFirst(path, "watch")), path);
      const text = this.resultText();
      // The module logs events only while this is non-zero (vfs.ts: `watchers.active`).
      this.words[this.watchingIndex]++;
      return text;
    });
    const record = { path: watched };
    this.watchedPaths.add(record);
    const stop = this.watchers.add(watched, recursive, listener);
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      stop();
      this.watchedPaths.delete(record);
      acquireLock(this.words, this.lockIndex);
      this.words[this.watchingIndex]--;
      releaseLock(this.words, this.lockIndex);
    };
  }

  // ---- open files ----

  private handleRead(handle: number, length: number, position: number | null): Uint8Array {
    // The module reads NaN as "at the offset" (README.md). A caller's own NaN
    // reads nothing in vfs.ts, as does any position past the end: send that.
    const at = position === null ? NaN : Number.isNaN(position) ? Infinity : position;
    return this.call("read", () => {
      this.ok(this.x.fs_handle_read(handle, length, at));
      return this.copyResult();
    });
  }

  private handleWrite(handle: number, data: Uint8Array, position: number | null): number {
    return this.call("write", () => {
      this.ok(this.x.fs_handle_write(handle, data.length, position ?? NaN));
      this.copyIn(data);
      return data.length;
    });
  }

  // ---- the call path ----

  /**
   * Runs `body` with the lock held: README.md, Rules. A process enters through
   * its slot and parks instead when it is being retired. A poisoned
   * filesystem refuses. Anything `body` throws other than the binding's own
   * errors is a trap in the module: it poisons. Watch events are taken out of
   * the log before the lock is released and delivered after it.
   */
  private call<T>(syscall: string, body: () => T): T {
    const words = this.words;
    let entered = false;
    let locked = false;
    let result: T | undefined;
    let failure: Error | null = null;
    let threw = false;
    let thrown: unknown;
    let events: Uint8Array | null = null;
    let dropped = false;
    // A caller at the end of its stack gets its RangeError here, before
    // anything is taken: thrown inside the module it would tear the tree.
    probeStack(STACK_PROBE_DEPTH, 1, 2, 3, 4, 5, 6, 7, 8);
    try {
      if (this.slotIndex >= 0) {
        this.enter();
        entered = true;
      }
      acquireLock(words, this.lockIndex);
      locked = true;
      if (words[this.poisonedIndex] !== 0) {
        throw createSystemError("EIO", syscall);
      }
      const before = words[this.eventsLengthIndex];
      const lostBefore = words[this.eventsDroppedIndex];
      try {
        result = body();
      } catch (error) {
        if (this.failure !== null && error === this.failure) {
          failure = this.failure;
        } else if (this.inModule) {
          throw this.poison(syscall);
        } else {
          // The binding's own JavaScript failed (out of memory for a copy, the
          // end of the stack): the module had returned, and the tree is whole.
          // What the module did before that still has its events to hand on.
          threw = true;
          thrown = error;
        }
      } finally {
        this.failure = null;
        this.inModule = false;
      }
      // What the kernel has to deliver: events in the log, or only the mark
      // that some were lost (with no memory the log itself can stay empty).
      const lost = words[this.eventsDroppedIndex] !== 0;
      if (words[this.eventsLengthIndex] !== 0 || lost) {
        if (!this.deliversEvents) {
          this.eventsPending ||= before === 0 && lostBefore === 0;
        } else {
          dropped = lost;
          events = this.takeEvents(syscall);
        }
      }
    } finally {
      if (locked) {
        releaseLock(words, this.lockIndex);
      }
      if (entered) {
        this.leave();
      }
    }
    if (events !== null) {
      this.deliver(events, dropped);
    }
    if (threw) {
      throw thrown;
    }
    if (failure !== null) {
      throw failure;
    }
    return result as T;
  }

  /**
   * Marks the slot "inside a call" (the token negated), or parks when the
   * slot no longer holds the token: the kernel retired this worker, which
   * must not touch the lock again.
   */
  private enter(): void {
    if (
      Atomics.compareExchange(this.words, this.slotIndex, this.token, -this.token) !== this.token
    ) {
      park();
    }
  }

  /**
   * Marks the slot "outside" again. When the kernel asked to retire this
   * worker during the call (`SLOT_RETIRING`), tells it the lock is let go of
   * for good and parks, to be terminated.
   */
  private leave(): void {
    const slot = this.slotIndex;
    if (Atomics.compareExchange(this.words, slot, -this.token, this.token) !== -this.token) {
      Atomics.store(this.words, slot, 0);
      Atomics.notify(this.words, slot);
      park();
    }
  }

  /** Marks the filesystem poisoned after a trap and returns the error to throw. */
  private poison(syscall: string): Error {
    Atomics.store(this.words, this.poisonedIndex, 1);
    return createSystemError("EIO", syscall);
  }

  /** Copies the event log out and empties it. */
  private takeEvents(syscall: string): Uint8Array {
    try {
      this.x.fs_events();
      const log = this.copyResult();
      this.x.fs_events_clear();
      return log;
    } catch (error) {
      if (this.inModule) {
        this.inModule = false;
        throw this.poison(syscall);
      }
      // The copy failed: the log is still whole, for the next call to take.
      throw error;
    }
  }

  private deliver(log: Uint8Array, dropped: boolean): void {
    const view = new DataView(log.buffer, log.byteOffset, log.byteLength);
    let at = 0;
    while (at < log.length) {
      const type = EVENT_TYPES[log[at]];
      const length = view.getUint32(at + 1, true);
      const path = decoder.decode(log.subarray(at + 5, at + 5 + length));
      at += 5 + length;
      this.watchers.emit(type, path);
    }
    if (dropped) {
      // The log overflowed and lost some: tell every watch something changed.
      for (const record of this.watchedPaths) {
        this.watchers.emit("rename", record.path);
      }
    }
  }

  private requireDelivery(): void {
    if (!this.deliversEvents) {
      throw new Error("watching needs the instance that delivers events (the kernel's)");
    }
  }

  /**
   * A call's return value: itself on success; on failure (-1) throws the error
   * vfs.ts throws for it, naming the caller's own strings.
   */
  private ok(result: number, path?: string, dest?: string): number {
    if (result >= 0) {
      return result;
    }
    const code = ERRNO_CODES[this.unsigned[this.errnoIndex]] ?? "EIO";
    const syscall = SYSCALL_NAMES[this.unsigned[this.syscallIndex]];
    const mode = this.unsigned[this.pathModeIndex];
    throw this.fail(
      code,
      syscall ?? "stat",
      mode === PATH_FIRST || mode === PATH_BOTH ? path : undefined,
      mode === PATH_BOTH ? dest : undefined,
    );
  }

  private fail(code: ErrnoCode, syscall: string, path?: string, dest?: string): Error {
    const error = createSystemError(code, syscall, path, dest);
    this.failure = error;
    return error;
  }

  /**
   * Writes the call's first path into the argument area and returns its length.
   * `dest` and `shown` only name the paths in the error when it does not fit.
   */
  private putFirst(path: string, syscall: string, dest?: string, shown?: string): number {
    const written = writeText(path, this.args, 0);
    if (written < 0) {
      throw this.fail("ENAMETOOLONG", syscall, shown ?? path, dest);
    }
    return written;
  }

  private putSecond(a: number, path: string, dest: string, syscall: string): number {
    const written = writeText(dest, this.args, a);
    if (written < 0) {
      throw this.fail("ENAMETOOLONG", syscall, path, dest);
    }
    return written;
  }

  /** The memory up to `end`, refreshed when the memory grew past the current view. */
  private view(end: number): Uint8Array {
    if (end > this.bytes.length) {
      this.bytes = new Uint8Array(this.memory.buffer);
    }
    return this.bytes;
  }

  /** A private copy of the bytes the call returned at `ptr`/`len`. */
  private copyResult(): Uint8Array {
    const ptr = this.unsigned[this.ptrIndex];
    const end = ptr + this.unsigned[this.lenIndex];
    return this.view(end).slice(ptr, end);
  }

  /** The returned bytes as text, decoded from a copy (TextDecoder may refuse a shared view). */
  private resultText(): string {
    return decoder.decode(this.copyResult());
  }

  /** Copies the caller's bytes to where the write call said they go. */
  private copyIn(data: Uint8Array): void {
    const ptr = this.unsigned[this.ptrIndex];
    this.view(ptr + data.length).set(data, ptr);
  }

  private statData(): StatData {
    const s = this.statRecord;
    return {
      dev: s[0],
      ino: s[1],
      mode: s[2],
      nlink: s[3],
      uid: s[4],
      gid: s[5],
      rdev: s[6],
      size: s[7],
      blksize: s[8],
      blocks: s[9],
      atimeMs: s[10],
      mtimeMs: s[11],
      ctimeMs: s[12],
      birthtimeMs: s[13],
    };
  }

  private parseListing(listing: Uint8Array, count: number): DirEntry[] {
    const view = new DataView(listing.buffer, listing.byteOffset, listing.byteLength);
    const entries: DirEntry[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      const type = ENTRY_KINDS[listing[at]];
      const length = view.getUint32(at + 1, true);
      const name = decoder.decode(listing.subarray(at + 5, at + 5 + length));
      at += 5 + length;
      entries.push({ name, type });
    }
    return entries;
  }
}

/** A file or directory opened with `SharedFs.open`: a handle in the module. */
class SharedFile implements OpenFile {
  readonly flags: number;
  private readonly handle: number;
  private readonly host: HandleHost;
  private closed = false;

  constructor(handle: number, flags: number, host: HandleHost) {
    this.handle = handle;
    this.flags = flags;
    this.host = host;
  }

  read(length: number, position: number | null): Uint8Array {
    this.usable("read");
    return this.host.read(this.handle, length, position);
  }

  write(data: Uint8Array, position: number | null): number {
    this.usable("write");
    return this.host.write(this.handle, data, position);
  }

  stat(): StatData {
    this.usable("fstat");
    return this.host.stat(this.handle);
  }

  truncate(length: number): void {
    this.usable("ftruncate");
    this.host.truncate(this.handle, length);
  }

  chmod(mode: number): void {
    this.usable("fchmod");
    this.host.chmod(this.handle, mode);
  }

  utimes(atimeMs: number, mtimeMs: number): void {
    this.usable("futime");
    this.host.utimes(this.handle, atimeMs, mtimeMs);
  }

  close(): void {
    this.usable("close");
    // As in vfs.ts: closed even if the call fails, and the module may reuse the number.
    this.closed = true;
    this.host.close(this.handle);
  }

  /** The closed check of vfs.ts: the module reuses a closed handle's number. */
  private usable(syscall: string): void {
    if (this.closed) {
      throw createSystemError("EBADF", syscall);
    }
  }
}

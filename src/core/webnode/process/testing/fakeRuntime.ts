// A `ProcessRuntime` for unit tests of builtins, the shell and the installer:
// a real `Vfs`, a per-runtime fd table with captured stdout/stderr and an
// in-memory stdin, in-memory pipes, fake children run by a test callback, and
// a loopback network. No workers and no kernel; nothing ever blocks.
import {
  createSystemError,
  systemErrorFromRecord,
  type ErrnoCode,
  type SystemErrorRecord,
} from "../../errors";
import { S_IFCHR, S_IFIFO, type OpenFile, type StatData } from "../../kernel/vfs/types";
import { Vfs } from "../../kernel/vfs/vfs";
import { endsByDefault, signalExitStatus } from "../../signals";
import { DEFAULT_UMASK, umaskBits } from "../../umask";
import { GID, UID } from "../platform";
import type {
  ByteChannel,
  ChildHandle,
  ExitStatus,
  FdKind,
  FdStreamBackend,
  FsBackend,
  NetBackend,
  ProcessBackend,
  ProcessRuntime,
  SpawnRequest,
  SpawnSyncRequest,
  SpawnSyncResult,
  StdioSpec,
  ThreadBackend,
  TtyBackend,
} from "../runtime";

/** What a fake child sees of its stdio while `FakeRuntimeOptions.spawn` runs it. */
export interface FakeChildIo {
  /** Bytes the parent wrote to the child's stdin so far, drained on each call; null once it is closed and drained. */
  readStdin(): Uint8Array | null;
  writeStdout(data: Uint8Array | string): void;
  writeStderr(data: Uint8Array | string): void;
}

export interface FakeRuntimeOptions {
  vfs?: Vfs;
  cwd?: string;
  env?: Record<string, string>;
  argv?: string[];
  pid?: number;
  /** Makes fds 0-2 terminals (default false): isatty true, windowSize 80x24. */
  tty?: boolean;
  /** Runs a spawned child; returns its exit code (or a promise of it). Default: throws ENOENT (syscall "spawn <command>"). */
  spawn?: (request: SpawnRequest, io: FakeChildIo) => number | Promise<number>;
  /** Where the kernel's entry for a large module is (`prepared.locate`). Default: it has none. */
  preparedEntry?: (filename: string) => string | null;
}

export interface FakeRuntime extends ProcessRuntime {
  readonly vfs: Vfs;
  /** Everything written to fd 1 / fd 2 so far, decoded as UTF-8. */
  stdout(): string;
  stderr(): string;
  /** Feeds bytes to fd 0; null closes it. */
  feedStdin(data: Uint8Array | string | null): void;
  /** The current ref() count. */
  readonly refCount: number;
  /** Set once processes.exit(code) was called (exit throws a `FakeExit` error carrying the code). */
  readonly exitCode: number | null;
  /**
   * The status `processes.forkAndExit` reported the process ended with, once
   * it was called; the runtime goes on as the new process (`pid`).
   */
  readonly forkedExit: ExitStatus | null;
  rawMode: boolean;
  /** Fires the tty resize listeners. */
  resize(columns: number, rows: number): void;
  /**
   * Delivers a signal to the onSignal listeners: one sent with kill, or with
   * `fromTerminal` the terminal's own (a Ctrl+C).
   */
  signal(name: string, fromTerminal?: boolean): void;
  /**
   * The reader of fd 1 or fd 2 goes away, as when a pipe's reader exits:
   * from now on a write to it fails with EPIPE.
   */
  closeReader(fd: 1 | 2): void;
}

/** Thrown by the fake `processes.exit(code)`, which must not return. */
export class FakeExit extends Error {
  code: number;

  constructor(code: number) {
    super(`process exited with code ${code}`);
    this.name = "FakeExit";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const FIRST_DYNAMIC_PORT = 49152;
const FIRST_CLIENT_PORT = 60000;

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function fail(code: ErrnoCode, syscall: string, path?: string): never {
  throw createSystemError(code, syscall, path);
}

/**
 * An in-memory pipe. Each fd or child stdio that refers to an end counts as a
 * reader or writer; the reading side sees end of stream once no writer is left.
 */
class Pipe {
  readers = 0;
  writers = 0;
  private chunks: Uint8Array[] = [];
  private listener: ((chunk: Uint8Array | null) => void) | null = null;
  private scheduled = false;
  private endDelivered = false;

  /** Queues a copy of `data` for the reader. */
  push(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }
    this.chunks.push(data.slice());
    this.schedule();
  }

  /**
   * Puts a copy of `data` back in front of what is queued, for the next read.
   * A reader that saw the end gets these, then the end again.
   */
  unshift(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }
    this.chunks.unshift(data.slice());
    this.endDelivered = false;
    this.schedule();
  }

  /** Up to `length` queued bytes; empty at end of stream; null when it would block. */
  take(length: number): Uint8Array | null {
    if (this.chunks.length === 0) {
      return this.writers === 0 ? new Uint8Array(0) : null;
    }
    const head = this.chunks[0];
    if (head.length <= length) {
      this.chunks.shift();
      return head;
    }
    this.chunks[0] = head.subarray(length);
    return head.slice(0, length);
  }

  /** Everything queued; empty when nothing is queued yet; null at end of stream. */
  drain(): Uint8Array | null {
    if (this.chunks.length === 0) {
      return this.writers === 0 ? null : new Uint8Array(0);
    }
    const all = concat(this.chunks);
    this.chunks = [];
    return all;
  }

  /** Starts (or, with null, stops) delivering chunks and end of stream asynchronously. */
  listen(listener: ((chunk: Uint8Array | null) => void) | null): void {
    this.listener = listener;
    if (listener !== null) {
      this.schedule();
    }
  }

  release(side: "read" | "write"): void {
    if (side === "read") {
      this.readers--;
      return;
    }
    this.writers--;
    if (this.writers === 0) {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.scheduled || this.listener === null) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    while (this.listener !== null && this.chunks.length > 0) {
      this.listener(this.chunks.shift() as Uint8Array);
    }
    if (this.listener !== null && this.writers === 0 && !this.endDelivered) {
      this.endDelivered = true;
      this.listener(null);
    }
  }
}

/** Where fd 1 or fd 2 writes end up. */
interface Capture {
  chunks: Uint8Array[];
  /** Its reader has gone (`closeReader`): writes fail with EPIPE. */
  readerGone?: boolean;
}

type FdEntry =
  | { type: "file"; file: OpenFile }
  | { type: "pipe"; pipe: Pipe; side: "read" | "write" }
  | { type: "capture"; capture: Capture; tty: boolean }
  | { type: "stdin"; pipe: Pipe; tty: boolean }
  | { type: "null" };

/** A child's view of one stdio stream: where it reads or writes, and what it holds open. */
interface ChildStream {
  read(): Uint8Array | null;
  write(data: Uint8Array): void;
  /** Drops the child's reference to a pipe end, if it holds one. */
  release(): void;
}

interface FakeChild {
  pid: number;
  /** Its process group: its own pid when started with `newGroup`, else this process's. */
  group: number;
  status: ExitStatus | null;
  listeners: ((status: ExitStatus) => void)[];
  streams: ChildStream[];
}

const DISCARD: ChildStream = {
  read: () => null,
  write: () => {},
  release: () => {},
};

/** A fake `ProcessRuntime` over a real `Vfs`: see the file comment. */
export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const vfs = options.vfs ?? new Vfs();
  const tty = options.tty ?? false;
  /** The pid the process started with, which also numbers its process group. */
  const pid = options.pid ?? 1;
  /** Its pid now: a new one after `forkAndExit`. */
  let currentPid = pid;
  let currentPpid = 0;
  let forkedExit: ExitStatus | null = null;
  const stdoutCapture: Capture = { chunks: [] };
  const stderrCapture: Capture = { chunks: [] };
  const stdinPipe = new Pipe();
  stdinPipe.readers = 1;
  stdinPipe.writers = 1;
  let stdinFed = true;

  const fds = new Map<number, FdEntry>([
    [0, { type: "stdin", pipe: stdinPipe, tty }],
    [1, { type: "capture", capture: stdoutCapture, tty }],
    [2, { type: "capture", capture: stderrCapture, tty }],
  ]);
  const children = new Map<number, FakeChild>();
  const resizeListeners = new Set<() => void>();
  const signalListeners: ((signal: string, fromTerminal: boolean) => boolean)[] = [];
  const servers = new Map<
    number,
    (channel: ByteChannel, remote: { address: string; port: number }) => void
  >();
  let windowSize = { columns: 80, rows: 24 };
  let nextPid = pid + 1;
  let nextClientPort = FIRST_CLIENT_PORT;
  let refCount = 0;
  let exitCode: number | null = null;

  /**
   * As the kernel's `proc.die`: the signal's default action, which ends the
   * process as 128 + its number unless it is to do nothing.
   */
  function die(signal: string): void {
    if (endsByDefault(signal)) {
      exitCode = signalExitStatus(signal);
    }
  }

  function allocate(entry: FdEntry): number {
    let fd = 0;
    while (fds.has(fd)) {
      fd++;
    }
    fds.set(fd, entry);
    return fd;
  }

  function entryOf(fd: number, syscall: string): FdEntry {
    const entry = fds.get(fd);
    if (entry === undefined) {
      fail("EBADF", syscall);
    }
    return entry;
  }

  function fileOf(fd: number, syscall: string): OpenFile {
    const entry = entryOf(fd, syscall);
    if (entry.type !== "file") {
      fail("EINVAL", syscall);
    }
    return entry.file;
  }

  function closeFd(fd: number): void {
    const entry = entryOf(fd, "close");
    fds.delete(fd);
    if (entry.type === "file") {
      entry.file.close();
    } else if (entry.type === "pipe") {
      entry.pipe.release(entry.side);
    } else if (entry.type === "stdin") {
      entry.pipe.release("read");
    }
  }

  function writeFd(fd: number, data: Uint8Array, position: number | null): number {
    const entry = entryOf(fd, "write");
    switch (entry.type) {
      case "file":
        return entry.file.write(data, position);
      case "capture":
        if (entry.capture.readerGone) {
          fail("EPIPE", "write");
        }
        entry.capture.chunks.push(data.slice());
        return data.length;
      case "pipe":
        if (entry.side !== "write") {
          fail("EBADF", "write");
        }
        if (entry.pipe.readers === 0) {
          fail("EPIPE", "write");
        }
        entry.pipe.push(data);
        return data.length;
      case "stdin":
        return fail("EBADF", "write");
      case "null":
        return data.length;
    }
  }

  function readFd(fd: number, length: number, position: number | null): Uint8Array {
    const entry = entryOf(fd, "read");
    switch (entry.type) {
      case "file":
        return entry.file.read(length, position);
      case "null":
        return new Uint8Array(0);
      case "capture":
        return fail("EBADF", "read");
      case "pipe":
      case "stdin": {
        if (entry.type === "pipe" && entry.side !== "read") {
          fail("EBADF", "read");
        }
        if (position !== null) {
          fail("ESPIPE", "read");
        }
        const bytes = entry.pipe.take(length);
        if (bytes === null) {
          // A real process would block here; a single-threaded test cannot.
          fail("EAGAIN", "read");
        }
        return bytes;
      }
    }
  }

  function streamStat(entry: FdEntry): StatData {
    const tty = (entry.type === "capture" || entry.type === "stdin") && entry.tty;
    const mode = tty || entry.type === "null" ? S_IFCHR | 0o620 : S_IFIFO | 0o600;
    return {
      dev: 0,
      ino: 0,
      mode,
      nlink: 1,
      uid: UID,
      gid: GID,
      rdev: 0,
      size: 0,
      blksize: 4096,
      blocks: 0,
      atimeMs: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      birthtimeMs: 0,
    };
  }

  function kindOf(fd: number): FdKind {
    const entry = entryOf(fd, "fstat");
    switch (entry.type) {
      case "file":
        return "file";
      case "pipe":
        return "pipe";
      case "null":
        return "null";
      case "capture":
      case "stdin":
        return entry.tty ? "tty" : "pipe";
    }
  }

  function isTty(fd: number): boolean {
    const entry = fds.get(fd);
    return (entry?.type === "capture" || entry?.type === "stdin") && entry.tty;
  }

  /** The process's file mode creation mask (`runtime.umask`). */
  let umask = DEFAULT_UMASK;
  /** Runs `create`, a call that may make a file or a directory, under the mask. */
  const creating = <T>(create: () => T): T => vfs.withUmask(umask, create);

  const fs: FsBackend = {
    stat: (path, followSymlinks) => vfs.stat(path, followSymlinks),
    fstat: (fd) => {
      const entry = entryOf(fd, "fstat");
      return entry.type === "file" ? entry.file.stat() : streamStat(entry);
    },
    exists: (path) => vfs.exists(path),
    readdir: (path) => vfs.readdir(path),
    mkdir: (path, recursive, mode, floor) =>
      creating(() => vfs.mkdir(path, recursive, mode, floor)),
    rmdir: (path) => vfs.rmdir(path),
    unlink: (path) => vfs.unlink(path),
    rm: (path, recursive, force) => vfs.rm(path, recursive, force),
    rename: (from, to) => vfs.rename(from, to),
    link: (existingPath, newPath) => vfs.link(existingPath, newPath),
    symlink: (target, path) => vfs.symlink(target, path),
    readlink: (path) => vfs.readlink(path),
    realpath: (path) => vfs.realpath(path),
    chmod: (path, mode, followSymlinks) => vfs.chmod(path, mode, followSymlinks),
    fchmod: (fd, mode) => fileOf(fd, "fchmod").chmod(mode),
    utimes: (path, atimeMs, mtimeMs, followSymlinks) =>
      vfs.utimes(path, atimeMs, mtimeMs, followSymlinks),
    futimes: (fd, atimeMs, mtimeMs) => fileOf(fd, "futime").utimes(atimeMs, mtimeMs),
    truncate: (path, length) => vfs.truncate(path, length),
    ftruncate: (fd, length) => fileOf(fd, "ftruncate").truncate(length),
    copyFile: (source, destination, mode) => vfs.copyFile(source, destination, mode),
    access: (path, mode) => vfs.access(path, mode),
    mkdtemp: (prefix) => creating(() => vfs.mkdtemp(prefix)),
    readFile: (path) => vfs.readFile(path),
    writeFile: (path, data, flags, mode) => creating(() => vfs.writeFile(path, data, flags, mode)),
    open: (path, flags, mode) =>
      allocate({ type: "file", file: creating(() => vfs.open(path, flags, mode)) }),
    close: closeFd,
    read: readFd,
    readAsync: async (fd, length, position, signal) => {
      // A pipe with nothing buffered yet is retried until bytes or its end
      // arrive, or until the caller gives the wait up (`signal`): the read
      // then takes nothing and fails with EINTR, as the kernel's does.
      for (;;) {
        try {
          return readFd(fd, length, position);
        } catch (error) {
          if ((error as { code?: string }).code !== "EAGAIN") {
            throw error;
          }
        }
        if (signal?.aborted) {
          fail("EINTR", "read");
        }
        await new Promise<void>((resolve) => {
          const retry = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", retry);
            resolve();
          };
          const timer = setTimeout(retry, 1);
          signal?.addEventListener("abort", retry, { once: true });
        });
      }
    },
    write: writeFd,
    fsync: (fd) => {
      fileOf(fd, "fsync");
    },
    watch: (path, recursive, listener) => {
      const base = vfs.realpath(path);
      const prefix = base === "/" ? "/" : `${base}/`;
      const ownName = base.slice(base.lastIndexOf("/") + 1);
      return vfs.watch(path, recursive, (event) => {
        const name = event.path === base ? ownName : event.path.slice(prefix.length);
        listener(event.eventType, name);
      });
    },
  };

  const fdStream: FdStreamBackend = {
    kind: kindOf,
    readStart: (fd, onChunk) => {
      const entry = entryOf(fd, "read");
      if (entry.type === "stdin" || (entry.type === "pipe" && entry.side === "read")) {
        entry.pipe.listen(onChunk);
        return;
      }
      fail("EBADF", "read");
    },
    readStop: (fd) => {
      const entry = entryOf(fd, "read");
      if (entry.type === "stdin" || entry.type === "pipe") {
        entry.pipe.listen(null);
      }
    },
    write: (fd, chunk, done) => {
      if (done === undefined) {
        // A blocking write, as write(2) is: its error is thrown, as sysClient's is.
        writeFd(fd, chunk, null);
        return;
      }
      let error: Error | null = null;
      try {
        writeFd(fd, chunk, null);
      } catch (caught) {
        error = caught as Error;
      }
      queueMicrotask(() => done(error));
    },
    // As the kernel's answer to a call: in a task, after the tasks queued
    // before. The report holds the process until it has run, as sysClient's does.
    reportWriteError: (_fd, error, done) => {
      runtime.ref();
      setTimeout(() => {
        try {
          done(error);
        } finally {
          runtime.unref();
        }
      }, 0);
    },
    close: closeFd,
    // As the kernel's fd.unread: reading stops, and the bytes go back in
    // front of what the pipe still holds, for its next reader. An fd that is
    // not a pipe's read end fails here, where the kernel's refusal reaches
    // nobody, so a test sees the misuse.
    unread: (fd, bytes) => {
      const entry = entryOf(fd, "read");
      if (
        !(entry.type === "pipe" && entry.side === "read") &&
        !(entry.type === "stdin" && !entry.tty)
      ) {
        fail("EINVAL", "read");
      }
      entry.pipe.listen(null);
      entry.pipe.unshift(bytes);
    },
  };

  const ttyBackend: TtyBackend = {
    isatty: isTty,
    windowSize: (fd) => {
      if (!isTty(fd)) {
        fail("ENOTTY", "ioctl");
      }
      return { ...windowSize };
    },
    setRawMode: (fd, enabled) => {
      if (!isTty(fd)) {
        fail("ENOTTY", "ioctl");
      }
      runtime.rawMode = enabled;
    },
    onResize: (listener) => {
      resizeListeners.add(listener);
      return () => {
        resizeListeners.delete(listener);
      };
    },
    // The fake has no process groups: a terminal has nothing else to take back from.
    reclaim: (fd) => {
      if (!isTty(fd)) {
        fail("ENOTTY", "ioctl");
      }
    },
    unread: (fd, bytes) => {
      const entry = fds.get(fd);
      if (!isTty(fd)) {
        fail("ENOTTY", "ioctl");
      }
      // The fake's only readable terminal is its stdin.
      if (entry?.type === "stdin") {
        entry.pipe.unshift(bytes);
      }
    },
  };

  /** The child's stream for stdio entry `index`, taking a reference on any pipe end it uses. */
  function childStream(
    spec: StdioSpec,
    index: number,
    parentFds: (number | null)[],
    command: string,
  ): ChildStream {
    if (spec === "ignore") {
      return DISCARD;
    }
    if (spec === "ipc") {
      throw new Error(`the fake runtime has no IPC channel (spawn ${command})`);
    }
    const reading = index === 0;
    if (spec === "pipe") {
      const pipe = new Pipe();
      pipe.readers = 1;
      pipe.writers = 1;
      // The parent holds the other end of the pipe as a new fd.
      parentFds[index] = allocate({ type: "pipe", pipe, side: reading ? "write" : "read" });
      return pipeStream(pipe, reading);
    }
    const entry = entryOf(spec === "inherit" ? index : spec, "spawn");
    switch (entry.type) {
      case "file":
        return {
          read: () => {
            const rest = entry.file.read(Number.MAX_SAFE_INTEGER, null);
            return rest.length === 0 ? null : rest;
          },
          write: (data) => {
            entry.file.write(data, null);
          },
          release: () => {},
        };
      case "capture":
        return {
          read: () => null,
          write: (data) => {
            entry.capture.chunks.push(data.slice());
          },
          release: () => {},
        };
      case "stdin":
        return reading ? pipeStream(entry.pipe, true) : DISCARD;
      case "pipe":
        if ((entry.side === "read") !== reading) {
          return DISCARD;
        }
        if (reading) {
          entry.pipe.readers++;
        } else {
          entry.pipe.writers++;
        }
        return pipeStream(entry.pipe, reading);
      case "null":
        return DISCARD;
    }
  }

  function pipeStream(pipe: Pipe, reading: boolean): ChildStream {
    let released = false;
    return {
      read: () => (reading ? pipe.drain() : null),
      write: (data) => {
        if (!reading) {
          pipe.push(data);
        }
      },
      release: () => {
        if (!released && pipe !== stdinPipe) {
          released = true;
          pipe.release(reading ? "read" : "write");
        }
      },
    };
  }

  function childIo(child: FakeChild): FakeChildIo {
    const stream = (index: number) => child.streams[index] ?? DISCARD;
    return {
      readStdin: () => stream(0).read(),
      writeStdout: (data) => {
        if (child.status === null) {
          stream(1).write(toBytes(data));
        }
      },
      writeStderr: (data) => {
        if (child.status === null) {
          stream(2).write(toBytes(data));
        }
      },
    };
  }

  function settle(child: FakeChild, status: ExitStatus): void {
    if (child.status !== null) {
      return;
    }
    child.status = status;
    for (const stream of child.streams) {
      stream.release();
    }
    const listeners = child.listeners;
    child.listeners = [];
    for (const listener of listeners) {
      listener(status);
    }
  }

  function startChild(request: SpawnRequest): { child: FakeChild; stdio: (number | null)[] } {
    const stdio: (number | null)[] = request.stdio.map(() => null);
    const childPid = nextPid++;
    const child: FakeChild = {
      pid: childPid,
      group: request.newGroup ? childPid : pid,
      status: null,
      listeners: [],
      streams: [],
    };
    child.streams = request.stdio.map((spec, index) =>
      childStream(spec, index, stdio, request.command),
    );
    children.set(child.pid, child);
    return { child, stdio };
  }

  /** Records a callback failure the way a crashing program would: on stderr, with code 1. */
  function crashed(child: FakeChild, error: unknown): ExitStatus {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    childIo(child).writeStderr(`${message}\n`);
    return { code: 1, signal: null };
  }

  const processes: ProcessBackend = {
    spawn: (request) => {
      const run = options.spawn;
      if (run === undefined) {
        fail("ENOENT", `spawn ${request.command}`, request.command);
      }
      const { child, stdio } = startChild(request);
      const io = childIo(child);
      queueMicrotask(() => {
        if (child.status !== null) {
          return;
        }
        let result: number | Promise<number>;
        try {
          result = run(request, io);
        } catch (error) {
          settle(child, crashed(child, error));
          return;
        }
        Promise.resolve(result).then(
          (code) => settle(child, { code, signal: null }),
          (error: unknown) => settle(child, crashed(child, error)),
        );
      });
      const handle: ChildHandle = { pid: child.pid, stdio, ipc: null };
      return handle;
    },
    spawnSync: (request) => spawnSync(request),
    onExit: (childPid, listener) => {
      const child = children.get(childPid);
      if (child === undefined) {
        fail("ESRCH", "waitpid");
      }
      if (child.status === null) {
        child.listeners.push(listener);
        return;
      }
      const status = child.status;
      queueMicrotask(() => listener(status));
    },
    pipe: () => {
      const pipe = new Pipe();
      pipe.readers = 1;
      pipe.writers = 1;
      const readFd = allocate({ type: "pipe", pipe, side: "read" });
      const writeFd = allocate({ type: "pipe", pipe, side: "write" });
      return { readFd, writeFd };
    },
    // As the kernel's kill(2): a positive pid is that process, 0 this
    // process's group, -1 every process but this one, and any other negative
    // pid the group -pid. This process is the leader of its own group.
    // Signal "0" only checks that there is someone to signal.
    kill: (target, signal) => {
      const members =
        target > 0
          ? [...children.values()].filter((child) => child.pid === target)
          : [...children.values()].filter(
              (child) => target === -1 || child.group === (target === 0 ? pid : -target),
            );
      const alive = members.filter((child) => child.status === null);
      const self = target === currentPid || target === 0 || target === -pid;
      if (alive.length === 0 && !self) {
        fail("ESRCH", "kill");
      }
      if (signal === "0") {
        return;
      }
      for (const child of alive) {
        settle(child, { code: null, signal });
      }
      // The caller last: the signal may end it.
      if (self) {
        runtime.signal(signal);
      }
    },
    exit: (code) => {
      exitCode = code;
      throw new FakeExit(code);
    },
    // The process ends for whoever waits; the runtime goes on as a new
    // process in the same group, its fds and children its own still. Its
    // parent is the pid that ended, as the kernel gives what a page process
    // leaves behind.
    forkAndExit: (status) => {
      forkedExit = { ...status };
      currentPpid = currentPid;
      currentPid = nextPid++;
      return currentPid;
    },
    onSignal: (listener) => {
      signalListeners.push(listener);
    },
    setHandledSignals: () => {},
    die: (signal) => die(signal),
  };

  function spawnSync(request: SpawnSyncRequest): SpawnSyncResult {
    const run = options.spawn;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const childPid = nextPid++;
    if (run === undefined) {
      const error: SystemErrorRecord = {
        code: "ENOENT",
        syscall: `spawnSync ${request.command}`,
        path: request.command,
      };
      return {
        pid: 0,
        status: { code: null, signal: null },
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        error,
      };
    }
    let input = request.input ?? null;
    const collect = (index: number, sink: Uint8Array[]) => (data: Uint8Array | string) => {
      const spec = request.stdio[index] ?? "pipe";
      const bytes = toBytes(data);
      if (spec === "pipe") {
        sink.push(bytes.slice());
      } else if (spec === "inherit") {
        writeFd(index, bytes, null);
      } else if (typeof spec === "number") {
        writeFd(spec, bytes, null);
      }
    };
    const io: FakeChildIo = {
      readStdin: () => {
        const next = input;
        input = null;
        return next;
      },
      writeStdout: collect(1, stdout),
      writeStderr: collect(2, stderr),
    };
    let status: ExitStatus;
    try {
      const code = run(request, io);
      if (typeof code !== "number") {
        throw new Error(
          `the fake spawn callback returned a promise for spawnSync (${request.command})`,
        );
      }
      status = { code, signal: null };
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      io.writeStderr(`${message}\n`);
      status = { code: 1, signal: null };
    }
    const result: SpawnSyncResult = {
      pid: childPid,
      status,
      stdout: concat(stdout),
      stderr: concat(stderr),
    };
    const limit = request.maxBuffer;
    if (limit !== undefined && (result.stdout.length > limit || result.stderr.length > limit)) {
      result.error = "ENOBUFS";
    }
    return result;
  }

  const net: NetBackend = {
    listen: (port, host, onConnection) => {
      let chosen = port;
      if (chosen === 0) {
        chosen = FIRST_DYNAMIC_PORT;
        while (servers.has(chosen)) {
          chosen++;
        }
      } else if (servers.has(chosen)) {
        throw systemErrorFromRecord({
          code: "EADDRINUSE",
          syscall: "listen",
          address: host,
          port: chosen,
        });
      }
      servers.set(chosen, onConnection);
      return {
        port: chosen,
        close: () => {
          if (servers.get(chosen) === onConnection) {
            servers.delete(chosen);
          }
        },
      };
    },
    connect: (port, host) => {
      const onConnection = servers.get(port);
      if (onConnection === undefined) {
        return Promise.reject(
          systemErrorFromRecord({ code: "ECONNREFUSED", syscall: "connect", address: host, port }),
        );
      }
      const [client, server] = createChannelPair();
      const remote = { address: "127.0.0.1", port: nextClientPort++ };
      queueMicrotask(() => onConnection(server, remote));
      return Promise.resolve(client);
    },
  };

  const threads: ThreadBackend = {
    isMainThread: true,
    threadId: 0,
    workerData: null,
    parentPort: null,
    spawn: () => {
      throw new Error("the fake runtime cannot start worker threads");
    },
  };

  const runtime: FakeRuntime = {
    get pid() {
      return currentPid;
    },
    get ppid() {
      return currentPpid;
    },
    argv: options.argv ?? ["/bin/node"],
    execArgv: [],
    env: options.env ?? {},
    cwd: options.cwd ?? "/",
    get umask() {
      return umask;
    },
    set umask(mask: number) {
      umask = umaskBits(mask);
    },
    // A test opens what the program it plays starts with before starting
    // it: the descriptors above 2 open when the program asks.
    get inheritedFds() {
      return [...fds.keys()].filter((fd) => fd > 2).sort((a, b) => a - b);
    },
    fs,
    fdStream,
    tty: ttyBackend,
    processes,
    net,
    threads,
    prepared: { locate: (filename) => options.preparedEntry?.(filename) ?? null },
    ref: () => {
      refCount++;
    },
    unref: () => {
      if (refCount === 0) {
        throw new Error("unref() without a matching ref()");
      }
      refCount--;
    },
    vfs,
    stdout: () => decodeAll(stdoutCapture),
    stderr: () => decodeAll(stderrCapture),
    feedStdin: (data) => {
      if (!stdinFed) {
        throw new Error("stdin was already closed");
      }
      if (data === null) {
        stdinFed = false;
        stdinPipe.release("write");
        return;
      }
      stdinPipe.push(toBytes(data));
    },
    get refCount() {
      return refCount;
    },
    get exitCode() {
      return exitCode;
    },
    get forkedExit() {
      return forkedExit;
    },
    rawMode: false,
    resize: (columns, rows) => {
      windowSize = { columns, rows };
      for (const listener of resizeListeners) {
        listener();
      }
    },
    signal: (name, fromTerminal = false) => {
      let handled = false;
      for (const listener of signalListeners) {
        handled = listener(name, fromTerminal) || handled;
      }
      // A signal no listener took (or with no listener at all) has its
      // default action, as the kernel's `proc.die` gives it.
      if (!handled) {
        die(name);
      }
    },
    closeReader: (fd) => {
      (fd === 1 ? stdoutCapture : stderrCapture).readerGone = true;
    },
  };
  return runtime;
}

function decodeAll(capture: Capture): string {
  return new TextDecoder().decode(concat(capture.chunks));
}

type ChannelEvent = { type: "data"; chunk: Uint8Array } | { type: "end" } | { type: "close" };

/** One end of an in-memory byte channel; events reach the peer in a microtask, in order. */
class LoopbackChannel implements ByteChannel {
  peer: LoopbackChannel | null = null;
  onEnd: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private dataListener: ((chunk: Uint8Array) => void) | null = null;
  private inbox: ChannelEvent[] = [];
  private scheduled = false;
  private sentEnd = false;
  private receivedEnd = false;
  private closed = false;

  get onData(): ((chunk: Uint8Array) => void) | null {
    return this.dataListener;
  }

  /** Setting a data listener delivers anything that arrived before it. */
  set onData(listener: ((chunk: Uint8Array) => void) | null) {
    this.dataListener = listener;
    if (listener !== null) {
      this.schedule();
    }
  }

  write(chunk: Uint8Array): void {
    if (this.closed || this.sentEnd) {
      throw new Error("write after end");
    }
    this.peer?.enqueue({ type: "data", chunk: chunk.slice() });
  }

  end(): void {
    if (this.closed || this.sentEnd) {
      return;
    }
    this.sentEnd = true;
    this.peer?.enqueue({ type: "end" });
    this.closeWhenBothEnded();
  }

  destroy(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.enqueue({ type: "close" });
    this.peer?.destroyFromPeer();
  }

  private destroyFromPeer(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.enqueue({ type: "close" });
  }

  private closeWhenBothEnded(): void {
    if (this.sentEnd && this.receivedEnd && !this.closed) {
      this.closed = true;
      this.enqueue({ type: "close" });
    }
  }

  private enqueue(event: ChannelEvent): void {
    this.inbox.push(event);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    while (this.inbox.length > 0) {
      const event = this.inbox[0];
      if (event.type === "data") {
        if (this.dataListener === null) {
          return;
        }
        this.inbox.shift();
        this.dataListener(event.chunk);
      } else if (event.type === "end") {
        this.inbox.shift();
        this.receivedEnd = true;
        this.onEnd?.();
        this.closeWhenBothEnded();
      } else {
        this.inbox.shift();
        this.onClose?.();
      }
    }
  }
}

/** Two linked `ByteChannel`s: what one writes the other receives, in a microtask. */
export function createChannelPair(): [ByteChannel, ByteChannel] {
  const a = new LoopbackChannel();
  const b = new LoopbackChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

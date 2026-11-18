// The shell's I/O plumbing: the table that maps a command's fd numbers to this
// process's real fds (what redirections and pipes rewrite), and the readers
// and writers built-in commands use on it.
// A write to a file is a write(2): it is in the file when the call returns,
// so the next command finds it there. Writes to pipes and terminals are
// ordered and never block the shell: they are handed to the kernel, which
// puts them in as the pipe has room (`fdStream.write` with a completion).
// The stages of a pipeline run in this one process, so a write that blocked
// would also stop the stage that reads it; instead, once more is queued than
// a pipe holds, a command waits asynchronously for its output
// (`CommandIo.settle`) when it ends and before it reads.
// Reads from files are synchronous. A read from a pipe or a terminal is a
// read(2) that waits in the kernel without blocking the shell: it takes at
// most what the command asked for, so the rest stays there for the next
// reader, and the signal that stops the command withdraws it
// (`ReadInterrupted`).
import { toSystemErrorRecord } from "../../../errors";
import type { SystemErrorRecord } from "../../../errors";
import { O_RDWR, O_WRONLY } from "../../../kernel/vfs/types";
import { runtime } from "../../runtime";
import type { FdKind } from "../../runtime";

const encoder = new TextEncoder();

/** Encodes text as UTF-8. */
export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes UTF-8 bytes. */
export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Joins byte chunks. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * A command's fds: logical fd → this process's fd, or null when closed
 * (`n>&-`). Commands get a copy; the shell's own table stays `{0:0, 1:1, 2:2}`
 * unless `exec` changes it.
 */
export type FdTable = Map<number, number | null>;

/** The table of a shell that has not redirected anything. */
export function baseFdTable(): FdTable {
  return new Map([
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
}

/**
 * The fd of the command itself that a path names (`/dev/stdin`, `/dev/stdout`,
 * `/dev/stderr`, `/dev/fd/N`), or null for any other path. The kernel would
 * open these on the shell process's fds; a command the shell runs in its own
 * process has those of its redirections and its pipeline instead.
 */
export function descriptorOf(path: string): number | null {
  switch (path) {
    case "/dev/stdin":
      return 0;
    case "/dev/stdout":
      return 1;
    case "/dev/stderr":
      return 2;
  }
  const match = /^\/dev\/fd\/(\d+)$/.exec(path);
  return match ? Number(match[1]) : null;
}

/** The highest fd a shell looks for among those it was started with (`exec 9<file; sh …`). */
const HIGHEST_INHERITED_FD = 9;

/**
 * The table of a shell as its process starts: its stdio, and the fds beyond
 * them that it was started with (a parent's `exec 3>&1; sh -c 'echo x >&3'`),
 * which its commands may name too.
 */
export function inheritedFdTable(): FdTable {
  const table = baseFdTable();
  for (const fd of runtime().inheritedFds) {
    if (fd <= HIGHEST_INHERITED_FD) {
      table.set(fd, fd);
    }
  }
  return table;
}

/**
 * Read offsets of the files the shell opened itself. The shell reads them at
 * an explicit position so a line-by-line `read` does not consume more than
 * one line per call.
 */
const offsetsByRuntime = new WeakMap<object, Map<number, number>>();

function fileOffsetsMap(): Map<number, number> {
  const rt = runtime();
  let map = offsetsByRuntime.get(rt);
  if (!map) {
    map = new Map();
    offsetsByRuntime.set(rt, map);
  }
  return map;
}

/** Starts tracking a file the shell opened for reading. */
export function trackFileOffset(fd: number): void {
  fileOffsetsMap().set(fd, 0);
}

/** What is behind each real fd the shell has read or written, until `closeFd`. */
const kindsByRuntime = new WeakMap<object, Map<number, FdKind>>();

function kindsMap(): Map<number, FdKind> {
  const rt = runtime();
  let map = kindsByRuntime.get(rt);
  if (!map) {
    map = new Map();
    kindsByRuntime.set(rt, map);
  }
  return map;
}

/**
 * What is behind real fd `fd`, or null when it is not open. Asked of the
 * kernel once per fd: every fd the shell opens it closes with `closeFd`.
 */
function kindOf(fd: number): FdKind | null {
  const kinds = kindsMap();
  let kind = kinds.get(fd);
  if (kind === undefined) {
    try {
      kind = runtime().fdStream.kind(fd);
    } catch {
      return null;
    }
    kinds.set(fd, kind);
  }
  return kind;
}

/** Creates a pipe for the shell: its two ends, each to be closed with `closeFd`. */
export function openPipe(): { readFd: number; writeFd: number } {
  const pipe = runtime().processes.pipe();
  // Known without asking the kernel.
  const kinds = kindsMap();
  kinds.set(pipe.readFd, "pipe");
  kinds.set(pipe.writeFd, "pipe");
  return pipe;
}

/** Real fds the shell opened on /dev/null to write to, by runtime. */
const sinksByRuntime = new WeakMap<object, Set<number>>();

/**
 * Opens /dev/null for the shell, to be closed with `closeFd`. The shell
 * opens it for most of its loops' redirections: what is behind the fd is
 * known without asking the kernel, and what is written to it goes nowhere,
 * so no write is made at all.
 */
export function openNull(flags: number): number {
  const rt = runtime();
  const fd = rt.fs.open("/dev/null", flags, 0o666);
  kindsMap().set(fd, "null");
  if ((flags & (O_WRONLY | O_RDWR)) !== 0) {
    let sinks = sinksByRuntime.get(rt);
    if (!sinks) {
      sinks = new Set();
      sinksByRuntime.set(rt, sinks);
    }
    sinks.add(fd);
  }
  return fd;
}

/** The readers of the pipes and terminals the shell reads, by real fd. */
const readersByRuntime = new WeakMap<object, Map<number, InputReader>>();

function inputReadersMap(): Map<number, InputReader> {
  const rt = runtime();
  let map = readersByRuntime.get(rt);
  if (!map) {
    map = new Map();
    readersByRuntime.set(rt, map);
  }
  return map;
}

/** Real fds a write found without a reader (EPIPE), by runtime. */
const brokenByRuntime = new WeakMap<object, Set<number>>();

function brokenPipesSet(): Set<number> {
  const rt = runtime();
  let set = brokenByRuntime.get(rt);
  if (!set) {
    set = new Set();
    brokenByRuntime.set(rt, set);
  }
  return set;
}

/** True once a write to real fd `fd` failed because nobody reads the pipe any more. */
export function isBrokenPipe(fd: number): boolean {
  return brokenByRuntime.get(runtime())?.has(fd) ?? false;
}

/** The writes to one real fd that the kernel has queued and not yet put in its pipe. */
interface Queued {
  bytes: number;
  /** Run once `bytes` is back to zero. */
  waiters: (() => void)[];
}

const queuedByRuntime = new WeakMap<object, Map<number, Queued>>();

function queuedMap(): Map<number, Queued> {
  const rt = runtime();
  let map = queuedByRuntime.get(rt);
  if (!map) {
    map = new Map();
    queuedByRuntime.set(rt, map);
  }
  return map;
}

/**
 * Resolves once none of `fds` has output still queued for its pipe, or
 * returns null when none has (so a command that wrote nothing waits for
 * nothing). A broken pipe counts as settled: its queued writes failed.
 */
export function writesSettled(fds: Iterable<number | null | undefined>): Promise<void> | null {
  const map = queuedByRuntime.get(runtime());
  if (!map || map.size === 0) {
    return null;
  }
  const waiting: Promise<void>[] = [];
  for (const fd of new Set(fds)) {
    const queued = fd === null || fd === undefined ? undefined : map.get(fd);
    if (queued && queued.bytes > 0) {
      waiting.push(new Promise((resolve) => queued.waiters.push(resolve)));
    }
  }
  if (waiting.length === 0) {
    return null;
  }
  return Promise.all(waiting).then(() => undefined);
}

/** Closes a real fd the shell owns. */
export function closeFd(fd: number): void {
  fileOffsetsMap().delete(fd);
  kindsByRuntime.get(runtime())?.delete(fd);
  sinksByRuntime.get(runtime())?.delete(fd);
  brokenByRuntime.get(runtime())?.delete(fd);
  // Writes still queued go in after the close, before the reader sees the end.
  queuedByRuntime.get(runtime())?.delete(fd);
  const readers = inputReadersMap();
  readers.get(fd)?.close();
  readers.delete(fd);
  try {
    runtime().fs.close(fd);
  } catch {
    // Already closed.
  }
}

/** Reads up to `length` bytes from a real fd that is a file; an empty array is end of file. */
export function readFd(fd: number, length: number): Uint8Array {
  const fileOffsets = fileOffsetsMap();
  const offset = fileOffsets.get(fd);
  if (offset !== undefined) {
    const bytes = runtime().fs.read(fd, length, offset);
    fileOffsets.set(fd, offset + bytes.length);
    return bytes;
  }
  return runtime().fs.read(fd, length, null);
}

/**
 * What a read that waited for a pipe or a terminal fails with when the
 * signal that stops its command came first. The read took nothing.
 */
export class ReadInterrupted extends Error {
  constructor() {
    super("read interrupted");
  }
}

/** How a command's reads of a pipe or a terminal wait. */
export interface ReadWait {
  /**
   * Aborted by the signal that stops the command: a read waiting then, and
   * any that would wait afterwards, fails with `ReadInterrupted`.
   */
  signal?: AbortSignal;
  /**
   * The command is a background job of a shell with job control: its read of
   * a terminal waits until `signal`, as a background process's read waits.
   */
  background?: boolean;
}

/**
 * How much a line read asks a file, a pipe or a terminal for at a time.
 * bash reads a pipe a byte at a time; that would be a call to the kernel
 * for each.
 */
const LINE_READ = 4096;

/** How much a read that takes whatever is there asks for at a time. */
export const CHUNK_READ = 65536;

/** One read(2) of an fd waiting in the kernel, shared by the callers here that wait for its input. */
interface PendingRead {
  /** Settles once the kernel has answered: with bytes, with the end of the input, or withdrawn. */
  readonly answered: Promise<void>;
  /** Withdraws the read once nobody waits for it. */
  readonly withdraw: AbortController;
  /** How many callers wait for it. */
  waiters: number;
  /** It found the end of the input. */
  ended: boolean;
}

/** Resolves when `waiting` does; rejects with `ReadInterrupted` once `signal` aborts first. */
function untilInterrupted(waiting: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return waiting;
  }
  if (signal.aborted) {
    return Promise.reject(new ReadInterrupted());
  }
  return new Promise((resolve, reject) => {
    const interrupted = (): void => reject(new ReadInterrupted());
    signal.addEventListener("abort", interrupted, { once: true });
    void waiting.then(() => {
      signal.removeEventListener("abort", interrupted);
      resolve();
    });
  });
}

/**
 * Reads a pipe or a terminal for the shell's commands. A read takes from the
 * fd at most what was asked for, as read(2) does, so what follows stays
 * there for the next reader, a program the shell starts among them. Only a
 * line read takes more than it uses: what is left is kept for the reads that
 * follow here, and goes back to the fd before a program starts, when the
 * shell ends and, for a pipe, as soon as the shell stops to wait
 * (`keepBriefly`).
 */
class InputReader {
  private readonly rt = runtime();
  private readonly fd: number;
  private readonly terminal: boolean;
  /** Read from the fd and not used yet. */
  private chunks: Uint8Array[] = [];
  private closed = false;
  private pending: PendingRead | null = null;
  /** A task is queued that gives `chunks` back to the pipe. */
  private returning = false;

  constructor(fd: number, terminal: boolean) {
    this.fd = fd;
    this.terminal = terminal;
  }

  /** The fd is being closed: a read waiting on it ends, and nothing reads it again. */
  close(): void {
    this.closed = true;
    this.chunks = [];
    this.pending?.withdraw.abort();
  }

  /**
   * Gives what was read here and not used back to the pipe or terminal, for
   * whoever reads it next, as bash, which reads a pipe a byte at a time,
   * leaves it there. The next read here reads from the fd again.
   */
  giveBack(): void {
    if (this.closed || this.chunks.length === 0) {
      return;
    }
    const bytes = concatBytes(this.chunks);
    this.chunks = [];
    try {
      if (this.terminal) {
        this.rt.tty.unread(this.fd, bytes);
      } else {
        this.rt.fdStream.unread(this.fd, bytes);
      }
    } catch {
      // The fd is gone.
    }
  }

  /**
   * What a read took past what it used serves the reads that follow at once
   * (a `while read` loop takes its lines from it). Once the shell stops to
   * wait for anything else, a pipe gets it back: a shell that never runs
   * again (it is killed while it waits) then holds nothing that the pipe's
   * next reader should have had. A terminal gets it back only before a
   * program starts and when the shell ends: giving keys back echoes them.
   */
  private keepBriefly(): void {
    if (this.terminal || this.returning || this.chunks.length === 0) {
      return;
    }
    this.returning = true;
    setTimeout(() => {
      this.returning = false;
      this.giveBack();
    }, 0);
  }

  /** Starts the read(2) every caller waiting for input from the fd shares. */
  private startRead(length: number): PendingRead {
    const withdraw = new AbortController();
    const pending: PendingRead = {
      withdraw,
      waiters: 0,
      ended: false,
      answered: this.rt.fs.readAsync(this.fd, length, null, withdraw.signal).then(
        (chunk) => {
          this.pending = null;
          if (chunk.length === 0) {
            pending.ended = true;
            return;
          }
          this.chunks.push(chunk);
          if (pending.waiters === 0) {
            // The kernel had answered before it heard that nobody waits.
            this.keepBriefly();
          }
        },
        (error: unknown) => {
          this.pending = null;
          // Withdrawn (EINTR), it took nothing. Any other failure is the end
          // of the input for whoever reads it.
          if (toSystemErrorRecord(error)?.code !== "EINTR") {
            pending.ended = true;
          }
        },
      ),
    };
    this.pending = pending;
    return pending;
  }

  /**
   * Waits until there are bytes to hand out, asking the fd for at most
   * `length`; false at the end of the input (for a terminal, an end of file
   * typed: it ends one read). Fails with `ReadInterrupted` once `wait.signal`
   * aborts: the read is withdrawn unless another caller still waits for it.
   */
  private async fill(length: number, wait: ReadWait): Promise<boolean> {
    if (this.terminal && wait.background) {
      await untilInterrupted(new Promise(() => {}), wait.signal);
    }
    while (this.chunks.length === 0) {
      if (this.closed) {
        return false;
      }
      if (wait.signal?.aborted) {
        throw new ReadInterrupted();
      }
      const pending = this.pending ?? this.startRead(length);
      pending.waiters += 1;
      try {
        await untilInterrupted(pending.answered, wait.signal);
      } finally {
        pending.waiters -= 1;
        if (pending.waiters === 0) {
          pending.withdraw.abort();
        }
      }
      if (pending.ended) {
        return false;
      }
    }
    return true;
  }

  /** True when a read here has to wait before it may take anything. */
  private mustWait(wait: ReadWait): boolean {
    return this.chunks.length === 0 || (this.terminal && wait.background === true);
  }

  /** Up to `length` bytes; empty at the end of the input. */
  async read(length: number, wait: ReadWait): Promise<Uint8Array> {
    if (this.mustWait(wait) && !(await this.fill(length, wait))) {
      return new Uint8Array(0);
    }
    const head = this.chunks[0];
    if (head.length <= length) {
      this.chunks.shift();
      this.keepBriefly();
      return head;
    }
    this.chunks[0] = head.subarray(length);
    this.keepBriefly();
    return head.subarray(0, length);
  }

  /** One line without its delimiter; null at the end of the input with nothing read. */
  async readLine(delimiter: number, wait: ReadWait): Promise<Line | null> {
    const parts: Uint8Array[] = [];
    for (;;) {
      let more: boolean;
      try {
        more = !this.mustWait(wait) || (await this.fill(LINE_READ, wait));
      } catch (error) {
        // The start of the line is not lost with the read: it is the next read's.
        this.chunks.unshift(...parts);
        this.keepBriefly();
        throw error;
      }
      if (!more) {
        return parts.length === 0 ? null : { line: concatBytes(parts), eof: true };
      }
      const head = this.chunks[0];
      const at = head.indexOf(delimiter);
      if (at >= 0) {
        parts.push(head.subarray(0, at));
        if (at + 1 < head.length) {
          this.chunks[0] = head.subarray(at + 1);
        } else {
          this.chunks.shift();
        }
        this.keepBriefly();
        return { line: concatBytes(parts), eof: false };
      }
      parts.push(head);
      this.chunks.shift();
    }
  }
}

/** A line as read, without its delimiter. `eof`: the input ended before one came. */
export interface Line {
  line: Uint8Array;
  eof: boolean;
}

/** The reader for a pipe or terminal fd, or null when `fd` is a file (or not open). */
function inputReader(fd: number): InputReader | null {
  const readers = inputReadersMap();
  const existing = readers.get(fd);
  if (existing) {
    return existing;
  }
  const kind = kindOf(fd);
  if (kind !== "pipe" && kind !== "tty") {
    return null;
  }
  const reader = new InputReader(fd, kind === "tty");
  readers.set(fd, reader);
  return reader;
}

/**
 * Gives what the shell read from pipe or terminal `fd` and did not use back
 * to it, before a program that reads `fd` starts (and as the shell ends):
 * the program gets the bytes after the line a `read` took, as with bash.
 */
export function giveBackInput(fd: number): void {
  readersByRuntime.get(runtime())?.get(fd)?.giveBack();
}

/**
 * Gives back what the shell holds of every pipe and terminal it read: it
 * ends, or is about to send a signal that may end it.
 */
export function giveBackAllInput(): void {
  for (const reader of readersByRuntime.get(runtime())?.values() ?? []) {
    reader.giveBack();
  }
}

/**
 * Gives `bytes` the shell read from terminal `fd` but did not use back to the
 * terminal, for whoever reads it next.
 */
export function unreadTerminal(fd: number, bytes: Uint8Array): void {
  if (bytes.length > 0) {
    runtime().tty.unread(fd, bytes);
  }
}

/**
 * Reads up to `length` bytes from any real fd; empty at end of input. On a
 * pipe or a terminal the read waits as `wait` says.
 */
export async function readAsync(
  fd: number,
  length: number,
  wait: ReadWait = {},
): Promise<Uint8Array> {
  const reader = inputReader(fd);
  if (reader) {
    return reader.read(length, wait);
  }
  return readFd(fd, length);
}

/** Reads a real fd to end of input. */
export async function readAllAsync(fd: number, wait: ReadWait = {}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await readAsync(fd, CHUNK_READ, wait);
    if (chunk.length === 0) {
      break;
    }
    chunks.push(chunk);
  }
  return concatBytes(chunks);
}

/** Reads one line from a real fd that is a file (without its delimiter); null at end of file. */
function readFileLine(fd: number, delimiter: number): Line | null {
  const parts: Uint8Array[] = [];
  const fileOffsets = fileOffsetsMap();
  const offset = fileOffsets.get(fd);
  if (offset !== undefined) {
    let position = offset;
    for (;;) {
      const bytes = runtime().fs.read(fd, LINE_READ, position);
      if (bytes.length === 0) {
        fileOffsets.set(fd, position);
        return parts.length === 0 ? null : { line: concatBytes(parts), eof: true };
      }
      const at = bytes.indexOf(delimiter);
      if (at >= 0) {
        parts.push(bytes.subarray(0, at));
        fileOffsets.set(fd, position + at + 1);
        return { line: concatBytes(parts), eof: false };
      }
      parts.push(bytes);
      position += bytes.length;
    }
  }
  // An fd we did not open may be shared with other processes: read byte by byte.
  for (;;) {
    const bytes = runtime().fs.read(fd, 1, null);
    if (bytes.length === 0) {
      return parts.length === 0 ? null : { line: concatBytes(parts), eof: true };
    }
    if (bytes[0] === delimiter) {
      return { line: concatBytes(parts), eof: false };
    }
    parts.push(bytes);
  }
}

/** Reads one line from any real fd; null at end of input with nothing read. */
export async function readLineAsync(
  fd: number,
  delimiter = 10,
  wait: ReadWait = {},
): Promise<Line | null> {
  const reader = inputReader(fd);
  if (reader) {
    return reader.readLine(delimiter, wait);
  }
  return readFileLine(fd, delimiter);
}

/**
 * A write to `fd` failed before `writeFd` returned: a reader gone (EPIPE)
 * marks the pipe broken, any other failure is told to `failed`, and without
 * `failed` whatever is not a bad fd is thrown.
 */
function writeFailed(
  fd: number,
  error: unknown,
  failed: ((error: SystemErrorRecord) => void) | undefined,
): false {
  const record = toSystemErrorRecord(error);
  if (record?.code === "EPIPE") {
    // Lets the pipeline stage writing here end (`Shell.checkSignals`).
    brokenPipesSet().add(fd);
    return false;
  }
  if (record && failed) {
    failed(record);
    return false;
  }
  if (record?.code === "EBADF") {
    return false;
  }
  throw error;
}

/**
 * Writes to a real fd. False when the write failed: the reader is gone
 * (EPIPE), or for any other reason, which `failed` is told. Without
 * `failed`, a bad fd is false too and any other failure is thrown.
 *
 * A file is written before this returns. A write to a pipe or a terminal
 * never waits: what the kernel has not yet put in is queued in order (see
 * `writesSettled`). If the reader goes away before it is in, the next write
 * here returns false; any other failure the kernel reports then reaches
 * `failed` after this has returned true.
 */
export function writeFd(
  fd: number,
  data: string | Uint8Array,
  failed?: (error: SystemErrorRecord) => void,
): boolean {
  const bytes = typeof data === "string" ? encode(data) : data;
  if (bytes.length === 0) {
    return true;
  }
  if (isBrokenPipe(fd)) {
    return false;
  }
  if (sinksByRuntime.get(runtime())?.has(fd)) {
    return true;
  }
  if (kindOf(fd) === "file") {
    // Through `fdStream` the kernel would write it later, after a command
    // that reads the file by its path had looked.
    try {
      runtime().fs.write(fd, bytes, null);
      return true;
    } catch (error) {
      return writeFailed(fd, error, failed);
    }
  }
  const map = queuedMap();
  let queued = map.get(fd);
  if (!queued) {
    queued = { bytes: 0, waiters: [] };
    map.set(fd, queued);
  }
  const record = queued;
  record.bytes += bytes.length;
  let immediate = true;
  let failure: unknown = null;
  runtime().fdStream.write(fd, bytes, (error) => {
    record.bytes -= bytes.length;
    if (error) {
      if (immediate) {
        failure = error;
      } else {
        const system = toSystemErrorRecord(error);
        if (system?.code !== "EPIPE") {
          // The kernel refused a write the command was told had gone.
          if (system) {
            failed?.(system);
          }
        } else if (map.get(fd) === record) {
          // A queued write found the reader gone: the stage writing here ends.
          brokenPipesSet().add(fd);
        }
      }
    }
    if (record.bytes <= 0) {
      for (const wake of record.waiters.splice(0)) {
        wake();
      }
    }
  });
  immediate = false;
  if (record.bytes <= 0 && map.get(fd) === record) {
    map.delete(fd);
  }
  return failure === null ? true : writeFailed(fd, failure, failed);
}

/** I/O for one command run in this process, bound to its fd table. */
export class CommandIo {
  readonly fds: FdTable;
  /** Set once a write to standard output failed: the command should stop. */
  broken = false;
  private wait: ReadWait;
  /** Why the first write to standard output that failed did, other than for a reader gone. */
  private writeError: SystemErrorRecord | null = null;
  /** The real fds this command wrote to. */
  private readonly written = new Set<number>();

  /** `wait`: how the command's reads of a pipe or a terminal wait. */
  constructor(fds: FdTable, wait: ReadWait = {}) {
    this.fds = fds;
    this.wait = wait;
  }

  /** The real fd behind logical `fd`, or null when closed. */
  fd(fd: number): number | null {
    return this.fds.get(fd) ?? null;
  }

  /** Writes to logical fd `fd`. */
  write(fd: number, data: string | Uint8Array): boolean {
    const real = this.fd(fd);
    if (real === null) {
      if (data.length === 0) {
        return true;
      }
      if (fd === 1) {
        // Closed (`>&-`): what write(2) on it would say.
        this.writeError ??= { code: "EBADF", syscall: "write" };
        this.broken = true;
      }
      return false;
    }
    if (fd === 1 && this.broken) {
      return false;
    }
    if (data.length > 0) {
      this.written.add(real);
    }
    const ok = writeFd(real, data, (error) => {
      if (fd === 1) {
        this.writeError ??= error;
        this.broken = true;
      }
    });
    if (!ok && fd === 1) {
      this.broken = true;
    }
    return ok;
  }

  /**
   * Why a write to standard output failed, when one did for another reason
   * than its reader going away (a bad fd, a full disk), and forgets it: the
   * caller reports it. A program says so and fails; one killed by SIGPIPE
   * says nothing. The kernel may report a failure only once the write has
   * returned: ask after `settle`.
   */
  takeWriteError(): SystemErrorRecord | null {
    const error = this.writeError;
    this.writeError = null;
    return error;
  }

  /**
   * True once a write of this command found nobody reading the pipe it wrote
   * to: a process would have got SIGPIPE for it. The kernel may refuse a
   * write only once it has returned: ask after `settle`.
   */
  lostReader(): boolean {
    for (const fd of this.written) {
      if (isBrokenPipe(fd)) {
        return true;
      }
    }
    return false;
  }

  /** Writes to standard output. */
  out(data: string | Uint8Array): boolean {
    return this.write(1, data);
  }

  /** Writes to standard error. */
  err(data: string): boolean {
    return this.write(2, data);
  }

  /**
   * Resolves once what this command wrote is in its pipes (null when nothing
   * is queued): how a command waits for its reader, as a blocked write(2)
   * would, without stopping the other stages of its pipeline.
   */
  settle(): Promise<void> | null {
    return writesSettled(this.fds.values());
  }

  /**
   * The command goes on after the signal that stopped its reads (the shell
   * ran its trap): they wait again, until `signal`.
   */
  resume(signal: AbortSignal): void {
    this.wait = { ...this.wait, signal };
  }

  /**
   * Waits, before the command reads more input, until what it wrote is in
   * its pipes. The signal that stops the command ends the wait as it ends a
   * read (`ReadInterrupted`): a reader that never reads holds nobody.
   */
  private async outputTaken(): Promise<void> {
    const settled = this.settle();
    if (settled) {
      await untilInterrupted(settled, this.wait.signal);
    }
  }

  /**
   * Reads up to `length` bytes from standard input, as read(2) does: on a
   * pipe or a terminal no more is taken, so the rest stays for the next
   * reader. Empty at end of input.
   */
  async readChunk(length = CHUNK_READ): Promise<Uint8Array> {
    const real = this.fd(0);
    if (real === null) {
      return new Uint8Array(0);
    }
    return this.readFrom(real, length);
  }

  /** True once a write to standard output failed, or its queued writes found the reader gone. */
  private outputGone(): boolean {
    const out = this.fd(1);
    if (out !== null && isBrokenPipe(out)) {
      this.broken = true;
    }
    return this.broken;
  }

  /**
   * Reads up to `length` bytes from real fd `fd`, an input the command
   * opened itself (a device named as an operand), or standard input. A
   * filter takes more input only once its output has gone on, and none once
   * nobody reads its output: its write would have ended it (SIGPIPE).
   */
  async readFrom(fd: number, length = CHUNK_READ): Promise<Uint8Array> {
    await this.outputTaken();
    if (this.outputGone()) {
      return new Uint8Array(0);
    }
    return readAsync(fd, length, this.wait);
  }

  /** Reads standard input to end of input. */
  async readAll(): Promise<Uint8Array> {
    const real = this.fd(0);
    if (real === null) {
      return new Uint8Array(0);
    }
    await this.outputTaken();
    return readAllAsync(real, this.wait);
  }

  /**
   * Bytes a command read from standard input past what it used: on a file
   * the shell reads at its own offset they go back to the input, as GNU head
   * and grep seek back on a regular file. A pipe or terminal cannot take
   * them back, and they are lost, as there.
   */
  unreadInput(bytes: Uint8Array): void {
    const real = this.fd(0);
    const offsets = fileOffsetsMap();
    const offset = real === null ? undefined : offsets.get(real);
    if (real !== null && offset !== undefined) {
      offsets.set(real, Math.max(0, offset - bytes.length));
    }
  }

  /** Reads one line from standard input, as bytes: a line need not be UTF-8. */
  async readLine(delimiter = 10): Promise<Line | null> {
    const real = this.fd(0);
    if (real === null) {
      return null;
    }
    await this.outputTaken();
    return readLineAsync(real, delimiter, this.wait);
  }

  /** True when logical `fd` is a terminal. */
  isTty(fd: number): boolean {
    const real = this.fd(fd);
    if (real === null) {
      return false;
    }
    try {
      return runtime().tty.isatty(real);
    } catch {
      return false;
    }
  }
}

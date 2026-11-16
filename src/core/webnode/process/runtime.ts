// What a process can ask the kernel for. Builtin modules and programs reach the
// kernel only through these interfaces, read from `runtime()`. In a process
// worker the host installs an implementation that crosses to the kernel
// (process/host.ts); a test installs a fake with `setRuntime`.
import type { SystemErrorRecord } from "../errors";
import type { DirEntry, StatData } from "../kernel/vfs/types";

/**
 * Synchronous filesystem calls. Every path is absolute (the caller resolves it
 * against the working directory first). A failure throws a `SystemError`.
 * File descriptors are this process's own; 0, 1 and 2 are its stdio.
 */
export interface FsBackend {
  stat(path: string, followSymlinks: boolean): StatData;
  fstat(fd: number): StatData;
  exists(path: string): boolean;
  readdir(path: string): DirEntry[];
  mkdir(path: string, recursive: boolean, mode: number): string | undefined;
  rmdir(path: string): void;
  unlink(path: string): void;
  rm(path: string, recursive: boolean, force: boolean): void;
  rename(from: string, to: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  realpath(path: string): string;
  chmod(path: string, mode: number, followSymlinks: boolean): void;
  fchmod(fd: number, mode: number): void;
  utimes(path: string, atimeMs: number, mtimeMs: number, followSymlinks: boolean): void;
  futimes(fd: number, atimeMs: number, mtimeMs: number): void;
  truncate(path: string, length: number): void;
  ftruncate(fd: number, length: number): void;
  copyFile(source: string, destination: string, mode: number): void;
  access(path: string, mode: number): void;
  mkdtemp(prefix: string): string;
  /** The whole file in one round trip. */
  readFile(path: string): Uint8Array;
  /** Writes the whole of `data`, opening with `flags` (`O_*`) and creating with `mode`. */
  writeFile(path: string, data: Uint8Array, flags: number, mode: number): void;
  open(path: string, flags: number, mode: number): number;
  close(fd: number): void;
  /**
   * Reads up to `length` bytes; an empty array is end of file. `position` null
   * reads at the file offset. On a pipe or terminal it blocks until bytes arrive.
   */
  read(fd: number, length: number, position: number | null): Uint8Array;
  /**
   * As `read`, without blocking: resolves when bytes (or the end) arrive. For
   * the callback and promise forms of `fs.read`, so a program waiting on a
   * pipe or terminal keeps running its other work.
   */
  readAsync(fd: number, length: number, position: number | null): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array, position: number | null): number;
  fsync(fd: number): void;
  /**
   * Reports changes at `path`; `filename` is relative to it. Returns the
   * function that stops the watch.
   */
  watch(
    path: string,
    recursive: boolean,
    listener: (eventType: "rename" | "change", filename: string) => void,
  ): () => void;
}

/** What is behind a file descriptor. */
export type FdKind = "file" | "pipe" | "tty" | "null";

/**
 * Stream I/O on a file descriptor that is a pipe or a terminal: this process's
 * stdio and the pipes to its children. Nothing here blocks.
 */
export interface FdStreamBackend {
  kind(fd: number): FdKind;
  /** Starts delivering what arrives on `fd`. `null` is end of stream. */
  readStart(fd: number, onChunk: (chunk: Uint8Array | null) => void): void;
  readStop(fd: number): void;
  /** Queues `chunk` for `fd`. Writes keep their order; `done` runs once the kernel has taken it. */
  write(fd: number, chunk: Uint8Array, done?: (error: Error | null) => void): void;
  close(fd: number): void;
}

export interface TtyBackend {
  isatty(fd: number): boolean;
  windowSize(fd: number): { columns: number; rows: number };
  /** Raw mode delivers each key as typed, with no echo and no line editing. */
  setRawMode(fd: number, enabled: boolean): void;
  /** Runs `listener` when the terminal is resized. Returns the function that removes it. */
  onResize(listener: () => void): () => void;
}

/** How one of a child's file descriptors is set up, as in `child_process` `stdio`. */
export type StdioSpec = "pipe" | "inherit" | "ignore" | "ipc" | number;

export interface SpawnRequest {
  /** A command name looked up on `env.PATH`, or a path. */
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: StdioSpec[];
  /** What the child sees as `argv[0]`, when it differs from `command`. */
  argv0?: string;
  /**
   * Starts the child in a process group of its own, so a Ctrl+C in the
   * terminal does not reach it: what a shell does for a background job.
   */
  newGroup?: boolean;
}

export interface ChildHandle {
  pid: number;
  /** This process's fd for each `"pipe"` entry of `stdio`, null for the others. */
  stdio: (number | null)[];
  /** The channel for an `"ipc"` entry. */
  ipc: MessagePort | null;
}

export interface ExitStatus {
  code: number | null;
  signal: string | null;
}

export interface SpawnSyncRequest extends SpawnRequest {
  input?: Uint8Array;
  timeoutMs?: number;
  maxBuffer?: number;
  killSignal?: string;
}

export interface SpawnSyncResult {
  pid: number;
  status: ExitStatus;
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** Set when the child could not start, timed out (`ETIMEDOUT`) or overran `maxBuffer` (`ENOBUFS`). */
  error?: SystemErrorRecord | "ETIMEDOUT" | "ENOBUFS";
}

export interface ProcessBackend {
  /** Starts a child. Throws a `SystemError` (`ENOENT`, `EACCES`) when it cannot. */
  spawn(request: SpawnRequest): ChildHandle;
  /** Runs a child to its exit, blocking this process. */
  spawnSync(request: SpawnSyncRequest): SpawnSyncResult;
  /** Runs `listener` when child `pid` exits. */
  onExit(pid: number, listener: (status: ExitStatus) => void): void;
  /**
   * Creates a pipe and returns this process's fds for its two ends. Pass one as
   * a child's `stdio` entry, then `close` this process's copy.
   */
  pipe(): { readFd: number; writeFd: number };
  /** Sends `signal` (`"SIGTERM"`, …) to `pid`. Throws `ESRCH` for no such process. */
  kill(pid: number, signal: string): void;
  /** Ends this process. Does not return. */
  exit(code: number): never;
  /**
   * Runs `listener` for each signal delivered to this process; it returns true
   * when it handled the signal, false to let the signal end the process.
   */
  onSignal(listener: (signal: string) => boolean): void;
  /**
   * Names the signals this process handles. Any other signal ends it at once,
   * even while it is busy. Until this is called, a process with an `onSignal`
   * listener handles SIGINT, SIGTERM and SIGHUP.
   */
  setHandledSignals(signals: string[]): void;
}

/** One end of a two-way byte stream between two processes (a TCP connection's stand-in). */
export interface ByteChannel {
  write(chunk: Uint8Array): void;
  /** Sends end of stream; the other side can still write. */
  end(): void;
  /** Closes both directions at once. */
  destroy(): void;
  onData: ((chunk: Uint8Array) => void) | null;
  onEnd: (() => void) | null;
  onClose: (() => void) | null;
}

export interface NetBackend {
  /**
   * Listens on `port` (0 lets the kernel choose). Throws `EADDRINUSE`. Each
   * connection arrives as a channel.
   */
  listen(
    port: number,
    host: string,
    onConnection: (channel: ByteChannel, remote: { address: string; port: number }) => void,
  ): { port: number; close(): void };
  /** Connects to a port another process (or this one) listens on. Rejects with `ECONNREFUSED`. */
  connect(port: number, host: string): Promise<ByteChannel>;
}

export interface ThreadSpawnRequest {
  /** The script's path, or its source when `eval` is set. */
  filename: string;
  eval: boolean;
  workerData: unknown;
  transferList: Transferable[];
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  cwd: string;
  name: string;
}

export interface ThreadHandle {
  threadId: number;
  /** The channel to the thread's `parentPort`. */
  port: MessagePort;
  /** Runs `listener` when the thread ends, with its exit code. */
  onExit(listener: (code: number) => void): void;
  terminate(): void;
}

export interface ThreadBackend {
  readonly isMainThread: boolean;
  readonly threadId: number;
  readonly workerData: unknown;
  readonly parentPort: MessagePort | null;
  spawn(request: ThreadSpawnRequest): ThreadHandle;
}

export interface ProcessRuntime {
  readonly pid: number;
  readonly ppid: number;
  /** `["node", "/abs/script.js", ...]`, as `process.argv`. */
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  /** The working directory; `process.chdir` assigns it. */
  cwd: string;
  readonly fs: FsBackend;
  readonly fdStream: FdStreamBackend;
  readonly tty: TtyBackend;
  readonly processes: ProcessBackend;
  readonly net: NetBackend;
  readonly threads: ThreadBackend;
  /**
   * Counts one thing that keeps the process alive: a listening server, an open
   * socket, a pending timer, a running child. The process exits when the count
   * returns to zero with nothing left to run.
   */
  ref(): void;
  unref(): void;
}

let current: ProcessRuntime | null = null;

/** The runtime of the process this code runs in. */
export function runtime(): ProcessRuntime {
  if (!current) {
    throw new Error("webnode: no process runtime is installed");
  }
  return current;
}

/** Installs the process runtime; a test passes a fake, and null to remove it. */
export function setRuntime(next: ProcessRuntime | null): void {
  current = next;
}

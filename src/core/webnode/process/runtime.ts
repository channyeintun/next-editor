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
  /**
   * `floor`: a directory `path` begins with that a recursive mkdir never
   * makes, nor anything above it; it fails with ENOENT instead
   * (`VfsApi.mkdir`).
   */
  mkdir(path: string, recursive: boolean, mode: number, floor?: string): string | undefined;
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
  /**
   * Sets a file's access and modification times; null for one sets it to
   * now. Explicit times need the owner (EPERM on root's files and devices);
   * both set to now, as `touch` asks, need the owner or write permission
   * (`VfsApi.utimes`), so `touch /dev/null` works.
   */
  utimes(
    path: string,
    atimeMs: number | null,
    mtimeMs: number | null,
    followSymlinks: boolean,
  ): void;
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
   *
   * With `signal` the caller can give the wait up, as a signal handler
   * interrupts read(2): once `signal` aborts, a read still waiting for a pipe
   * or a terminal is withdrawn. It rejects with EINTR and takes nothing, so
   * what arrives afterwards is the next reader's. The kernel decides which
   * happened: a read it had answered before it heard of the abort resolves
   * with its bytes all the same, and the caller uses them or gives them back
   * (`fdStream.unread`, `tty.unread`). With `signal` aborted already, the
   * read takes what is there to take and is withdrawn otherwise. A read of a
   * file never waits, so it is never withdrawn.
   */
  readAsync(
    fd: number,
    length: number,
    position: number | null,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
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
 * stdio and the pipes to its children. Only a `write` without `done` blocks.
 */
export interface FdStreamBackend {
  kind(fd: number): FdKind;
  /**
   * Starts delivering what arrives on `fd`. `null` is end of stream. What a
   * terminal sent this process and `onChunk` never got (the process ended,
   * or closed `fd`, or stopped reading and never started again) goes back to
   * the terminal for its next reader, as read(2) would have left it there.
   */
  readStart(fd: number, onChunk: (chunk: Uint8Array | null) => void): void;
  /**
   * Stops delivering. A reader keeps what it was handed and gets nothing
   * more: what a pipe had sent this process by then goes back to the pipe,
   * in order, for its next reader (this one, if it starts again), and keeps
   * counting against what the pipe holds.
   */
  readStop(fd: number): void;
  /**
   * Writes `chunk` to `fd`, in order with every other write to it. While the
   * writes this process has handed the kernel for `fd`, and the kernel has
   * not yet said are in, stay within what a pipe holds (64 KiB) and number
   * at most 256, the write is handed over without waiting and is complete at
   * once (`done` runs before `write` returns); the kernel still puts it in
   * after this process ends.
   * Past that, and for the first write and the first after a pipe this
   * process writes to lost its reader, the kernel is asked:
   *  - with `done`, the process goes on and `done` runs once the bytes are
   *    in, or with the error (EPIPE when the reader went first);
   *  - without `done`, the write blocks until they are in, as write(2) does,
   *    and throws the error.
   */
  write(fd: number, chunk: Uint8Array, done?: (error: Error | null) => void): void;
  /**
   * Hands `error`, which a blocking `write` to `fd` threw, to `done` once this
   * process has handled every message the kernel sent it before: from the
   * event loop, in order with them, where an asynchronous write's error would
   * come. A signal the kernel sent while the write waited (a Ctrl+C that also
   * ended the pipe's reader) is handled first, as Node runs its handler
   * before the EPIPE such a write reports.
   */
  reportWriteError(fd: number, error: Error, done: (error: Error) => void): void;
  close(fd: number): void;
  /**
   * Gives pipe `fd` back what this process read from it and did not use:
   * `bytes` (what its reader kept), then what the kernel had sent and no
   * reader here was handed. The next reader of the pipe, a child among them,
   * gets them in order, as read(2) would have left them there. Stops reading
   * `fd` first. Kept in order with the calls that follow. `fd` must be the
   * read end of a pipe: for anything else the kernel gives nothing back, and
   * the caller does not hear of it (the request is not waited for).
   */
  unread(fd: number, bytes: Uint8Array): void;
}

export interface TtyBackend {
  isatty(fd: number): boolean;
  windowSize(fd: number): { columns: number; rows: number };
  /**
   * Raw mode delivers each key as typed, with no echo and no line editing.
   * The terminal changes as libuv changes it for Node: turning raw mode off
   * puts back the mode this process found when it turned it on (raw, under a
   * parent that had made the terminal raw), asking for the mode this process
   * has already does nothing, and the kernel puts back the mode the process
   * first found when it ends, however it ends. A request from outside the
   * terminal's foreground (a background job, or what an ended process left
   * running) changes nothing. Throws ENOTTY when `fd` is not a terminal.
   */
  setRawMode(fd: number, enabled: boolean): void;
  /** Runs `listener` when the terminal is resized. Returns the function that removes it. */
  onResize(listener: () => void): () => void;
  /**
   * Gives `bytes` this process read from terminal `fd` but did not use back to
   * the terminal, in front of its input, for the next reader (the keys a
   * shell's line editor got after the line it runs). Kept in order with the
   * calls that follow it.
   */
  unread(fd: number, bytes: Uint8Array): void;
  /**
   * Takes terminal `fd` back for this process's group once a foreground job
   * it ran has ended, as a job-control shell does (tcsetpgrp). What the job
   * left running there (an orphan whose parent ended) moves to the group the
   * job would have had on Linux, numbered by its first process, so the
   * terminal's Ctrl+C and input no longer reach it. Kept in order with the
   * calls that follow. Throws ENOTTY when `fd` is not a terminal.
   */
  reclaim(fd: number): void;
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
   * Starts the child in a process group of its own, numbered by its pid, so
   * a Ctrl+C in the terminal does not reach it: what a shell does for a
   * background job, and `child_process` for a `detached` child. What the
   * child starts joins the group, and `kill(-pid, …)` reaches all of it.
   */
  newGroup?: boolean;
  /**
   * The child stays in its parent's working directory (`cwd` is the parent's
   * own), as after a fork, rather than changing into `cwd`; the kernel checks
   * `cwd` only when this is not set.
   */
  inheritCwd?: boolean;
  /**
   * The child's file mode creation mask when it is not to be a copy of this
   * process's: a subshell's own, which its commands run under.
   */
  umask?: number;
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
  /**
   * Sends `signal` (`"SIGTERM"`, …; `"0"` only checks) as kill(2) does: to
   * process `pid`, or for 0 to this process's group, for -1 to every process
   * but this one, and for any other negative `pid` to the process group
   * `-pid`. Throws `ESRCH` when there is no such process or group.
   */
  kill(pid: number, signal: string): void;
  /** Ends this process. Does not return. */
  exit(code: number): never;
  /**
   * fork(2) with the parent's _exit(2) right after it, the one fork a worker
   * can do (it cannot be copied): this process ends with `status` for
   * everything that waits for it (its parent's `onExit` and `spawnSync`, a
   * `child_process` "exit", the page), and this worker goes on as a new
   * process. Returns the new pid; `ProcessRuntime.pid` and `ppid` read the
   * new process's from then on.
   *
   * The new process is the orphan the forked child would be: its parent is
   * the one the kernel gives a process whose parent has ended, so nobody
   * hears its exit, and it is out of the terminal's foreground. It keeps the
   * process group (it may be the only member of a group numbered by the old
   * pid), the controlling terminal, the working directory, the file mode
   * creation mask, the environment, the signals it handles, its threads,
   * its listening ports and its connections. Its file descriptors are this
   * process's, moved and never closed: a pipe it writes to ends only when
   * the new process ends. The children this process started are the
   * worker's: they become the new process's, and it hears their exit.
   *
   * From then on the old pid names no process: kill(2) of it fails with
   * ESRCH. The new pid is signalled, listed and waited for like any other.
   * Throws EINVAL from a worker thread.
   */
  forkAndExit(status: ExitStatus): number;
  /**
   * Ends this process as `signal` ends one that does not handle it, as a
   * shell does with kill(getpid(), sig) once its cleanup is done: its parent
   * sees the signal, not an exit code. The kernel ends it once the request
   * arrives, after the writes made before it; this process should do nothing
   * more. A signal whose default action is to do nothing leaves it running.
   */
  die(signal: string): void;
  /**
   * Runs `listener` for each signal delivered to this process; it returns true
   * when it handled the signal, false to let the signal end the process.
   * `fromTerminal` is true for the terminal's own signal (a Ctrl+C), which
   * reached every process of the terminal's foreground group, and false for
   * one sent with kill, which reached only the processes it named.
   */
  onSignal(listener: (signal: string, fromTerminal: boolean) => boolean): void;
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
  /** The port the kernel labels this end with, for a channel a process connected itself. */
  localPort?: number;
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
  /** This process's pid: a new one once it has gone on as a new process (`processes.forkAndExit`). */
  readonly pid: number;
  readonly ppid: number;
  /** `["node", "/abs/script.js", ...]`, as `process.argv`. */
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  /** The working directory; `process.chdir` assigns it. */
  cwd: string;
  /**
   * The file mode creation mask, umask(2): the permission bits taken off the
   * mode of each file and directory this process creates (`fs.open` and
   * `fs.writeFile` with `O_CREAT`, `fs.mkdir`, `fs.mkdtemp`). Assigning sets
   * it, keeping the permission bits of the value. It is the process's: its
   * worker threads read and create under the same one, and a child starts
   * with a copy.
   */
  umask: number;
  /**
   * The descriptors above 2 this process started with, lowest first (a
   * parent shell's `exec 3>&1`). Known without a call to the kernel.
   */
  readonly inheritedFds: readonly number[];
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

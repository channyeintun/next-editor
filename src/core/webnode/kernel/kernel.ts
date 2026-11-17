// The kernel: the one place that owns what processes share. It holds the
// filesystem, the process table, every file descriptor, pipe and terminal, and
// the table of listening ports, and it answers the calls process workers make
// (process/sysClient.ts is the other end). It runs inside the kernel worker;
// workers are created through `KernelHost` so tests can drive it without any.
import { createPortChannel } from "../byteChannel";
import { createSystemError, toSystemErrorRecord } from "../errors";
import {
  DEFAULT_PATH,
  HOME_DIR,
  HOSTNAME,
  SHELL_PATH,
  TMP_DIR,
  USERNAME,
} from "../process/platform";
import type {
  ByteChannel,
  ExitStatus,
  SpawnRequest,
  SpawnSyncRequest,
  SpawnSyncResult,
  StdioSpec,
  ThreadSpawnRequest,
} from "../process/runtime";
import type {
  KernelEvent,
  KernelMessage,
  MountEntry,
  PageSpawnOptions,
  ProcessInit,
  ProcessMessage,
  TerminalSize,
} from "../protocol";
import { INITIAL_SYNC_BUFFER_BYTES, serializeError } from "../protocol";
import { encodePayload, writeSyncAnswer } from "./codec";
import type { EncodedPayload } from "./codec";
import { installBuiltinCommands, resolveExec } from "./exec";
import type { ByteSource } from "./streams";
import { Pipe, Terminal } from "./streams";
import type { SharedFilesystem } from "../sharedfs/boot";
import type { OpenFile, StatData, VfsApi } from "./vfs/types";
import { O_CREAT, O_TRUNC, O_WRONLY, S_IFCHR, S_IFIFO } from "./vfs/types";

/** The part of a Worker the kernel uses. */
export interface KernelWorker {
  postMessage(message: KernelMessage, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ProcessMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface KernelHost {
  /** Starts a process worker. */
  createWorker(name: string): KernelWorker;
  /** Tells the page something happened. */
  emit(event: KernelEvent): void;
  /**
   * The shared filesystem, when the kernel's `vfs` is one: each worker is
   * admitted to it at its start and retired from it before it is terminated
   * (sharedfs/README.md).
   */
  sharedFs?: SharedFilesystem | null;
}

type Description =
  | { kind: "file"; refs: number; file: OpenFile }
  | { kind: "pipe-read"; refs: number; pipe: Pipe }
  | { kind: "pipe-write"; refs: number; pipe: Pipe }
  | { kind: "tty"; refs: number; terminal: Terminal; output: boolean }
  | { kind: "null"; refs: number };

interface Proc {
  /** Unique per worker. A process's id is its pid; a thread has its own. */
  id: number;
  pid: number;
  ppid: number;
  /** The process group: what a Ctrl+C on the terminal reaches together. */
  pgid: number;
  /** For a thread: the process it belongs to. */
  owner: Proc | null;
  /** The process or thread that started this process and hears its `child-exit`; null for none. */
  reportTo: Proc | null;
  threadId: number;
  worker: KernelWorker;
  argv: string[];
  /** Shared by a process and its threads. */
  fds: Map<number, Description>;
  syncBuffer: SharedArrayBuffer;
  pendingAnswer: { ok: boolean; payload: EncodedPayload } | null;
  children: Set<number>;
  threads: Set<Proc>;
  terminal: Terminal | null;
  pageOwned: boolean;
  handledSignals: Set<string>;
  /** This worker's slot in the shared filesystem, while it holds one. */
  fsEntry: { slot: number; token: number } | null;
  watches: Map<number, () => void>;
  pumps: Map<number, () => void>;
  /** Cancels each blocking read this worker is waiting in. */
  pendingReads: Set<() => void>;
  /** Listener id → port. */
  listeners: Map<number, number>;
  channels: Set<number>;
  /** Ports posted ahead of a blocking spawn, by token. */
  handoffs: Map<string, { port: MessagePort; data: unknown }>;
  exitWaiters: ((status: ExitStatus) => void)[];
  exited: boolean;
}

/** Where spawnSync collects a child's output. */
interface Capture {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  input?: Uint8Array;
  /** The most bytes kept from stdout or from stderr. */
  maxBuffer?: number;
  /** Runs when stdout or stderr went over `maxBuffer`. */
  onOverflow?: () => void;
}

interface Listener {
  proc: Proc;
  listenerId: number;
}

interface Channel {
  /** Worker ids at each end; 0 is the kernel itself. */
  ends: [number, number];
  /** The kernel's own end, when it has one. */
  kernelEnd: { kill(): void } | null;
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGWINCH: 28,
};

const DEFAULT_TERMINAL: TerminalSize = { cols: 80, rows: 24 };
const EPHEMERAL_PORT_START = 49152;
const WATCH_BATCH_MS = 16;

type Handler = (proc: Proc, ...args: never[]) => unknown;

/** The stat a pipe or terminal reports. */
function streamStat(mode: number): StatData {
  const now = Date.now();
  return {
    dev: 2,
    ino: 0,
    mode,
    nlink: 1,
    uid: 1,
    gid: 1,
    rdev: 0,
    size: 0,
    blksize: 4096,
    blocks: 0,
    atimeMs: now,
    mtimeMs: now,
    ctimeMs: now,
    birthtimeMs: now,
  };
}

export class Kernel {
  readonly vfs: VfsApi;
  readonly workdir: string;

  private readonly host: KernelHost;
  private readonly procs = new Map<number, Proc>();
  private readonly listening = new Map<number, Listener>();
  private readonly channels = new Map<number, Channel>();
  private readonly pageWatches = new Map<number, () => void>();
  private pendingWatchEvents = new Map<string, KernelEvent>();
  private watchFlush: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private nextListenerId = 1;
  private nextChannelId = 1;
  private nextWatchId = 1;
  private nextEphemeralPort = EPHEMERAL_PORT_START;
  private disposed = false;
  private readonly handlers: Record<string, Handler>;

  constructor(vfs: VfsApi, host: KernelHost, workdirName: string) {
    this.vfs = vfs;
    this.host = host;
    this.workdir = `${HOME_DIR}/projects/${workdirName}`;
    vfs.mkdir(this.workdir, true, 0o755);
    vfs.mkdir(TMP_DIR, true, 0o777);
    vfs.mkdir("/dev", true, 0o755);
    installBuiltinCommands(vfs);
    this.handlers = this.createHandlers();
  }

  // -------------------------------------------------------------------------
  // The page's side
  // -------------------------------------------------------------------------

  /** The environment a process the page starts gets, before the page's own variables. */
  defaultEnvironment(): Record<string, string> {
    return {
      PATH: `${DEFAULT_PATH}:${this.workdir}/node_modules/.bin`,
      HOME: HOME_DIR,
      PWD: this.workdir,
      SHELL: SHELL_PATH,
      USER: USERNAME,
      LOGNAME: USERNAME,
      HOSTNAME,
      TMPDIR: TMP_DIR,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      NODE_ENV: "development",
    };
  }

  /** Writes a tree into the filesystem. */
  mount(entries: MountEntry[]): void {
    const made = new Set<string>();
    const ensureDirectory = (path: string) => {
      if (!made.has(path)) {
        this.vfs.mkdir(path, true, 0o755);
        made.add(path);
      }
    };
    for (const entry of entries) {
      if ("directory" in entry) {
        ensureDirectory(entry.path);
      } else {
        ensureDirectory(entry.path.slice(0, entry.path.lastIndexOf("/")) || "/");
        this.vfs.writeFile(entry.path, entry.data, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
      }
    }
  }

  /** Starts a process for the page, with a terminal as its stdio. Returns its pid. */
  spawnFromPage(command: string, args: string[], options: PageSpawnOptions): number {
    const env = this.defaultEnvironment();
    for (const [name, value] of Object.entries(options.env ?? {})) {
      env[name] = String(value);
    }
    const cwd = options.cwd ? this.resolveWorkdirPath(options.cwd) : this.workdir;
    env.PWD = cwd;
    const resolved = resolveExec(this.vfs, command, args, env, cwd);

    const id = this.nextId++;
    const showOutput = options.output !== false;
    const terminal = new Terminal(
      options.terminal ?? DEFAULT_TERMINAL,
      (data) => {
        if (showOutput) {
          this.host.emit({ event: "output", pid: id, data });
        }
      },
      (pid) => this.interruptGroup(pid),
    );
    const fds = new Map<number, Description>();
    const description: Description = { kind: "tty", refs: 3, terminal, output: true };
    fds.set(0, description);
    fds.set(1, description);
    fds.set(2, description);

    this.startProcess({
      id,
      ppid: 0,
      pgid: id,
      parent: null,
      reportTo: null,
      fds,
      terminal,
      pageOwned: true,
      resolved,
      env,
      cwd,
      ipc: null,
    });
    return id;
  }

  /** What the page typed into process `pid`'s terminal. */
  writeInput(pid: number, data: string): void {
    this.procs.get(pid)?.terminal?.input(data);
  }

  resizeTerminal(pid: number, size: TerminalSize): void {
    const terminal = this.procs.get(pid)?.terminal;
    if (!terminal) {
      return;
    }
    terminal.cols = size.cols;
    terminal.rows = size.rows;
    for (const proc of this.procs.values()) {
      if (proc.terminal === terminal) {
        proc.worker.postMessage({ type: "resize", terminal: size });
      }
    }
  }

  /** Ends `pid` and every process it started. */
  killTree(pid: number): void {
    const proc = this.procs.get(pid);
    if (!proc) {
      return;
    }
    for (const child of Array.from(proc.children)) {
      this.killTree(child);
    }
    this.finish(proc, { code: null, signal: "SIGKILL" });
  }

  /** Watches a path for the page. Returns the id its events carry. */
  watchFromPage(path: string, recursive: boolean): number {
    const root = this.resolveWorkdirPath(path);
    const watchId = this.nextWatchId++;
    const stop = this.vfs.watch(root, recursive, (event) => {
      const filename = relativeName(root, event.path);
      // One event per file and kind in each batch: an install touches
      // thousands of files, and the page only needs to know which.
      const key = `${watchId}\0${event.eventType}\0${filename}`;
      if (!this.pendingWatchEvents.has(key)) {
        this.pendingWatchEvents.set(key, {
          event: "watch",
          watchId,
          eventType: event.eventType,
          filename,
        });
      }
      this.watchFlush ??= setTimeout(() => this.flushWatchEvents(), WATCH_BATCH_MS);
    });
    this.pageWatches.set(watchId, stop);
    return watchId;
  }

  unwatchFromPage(watchId: number): void {
    this.pageWatches.get(watchId)?.();
    this.pageWatches.delete(watchId);
  }

  /** An absolute path for one the page gave relative to the working directory. */
  resolveWorkdirPath(path: string): string {
    if (path.startsWith("/")) {
      return path;
    }
    const trimmed = path.replace(/^(?:\.\/)+/, "");
    return trimmed === "" || trimmed === "." ? this.workdir : `${this.workdir}/${trimmed}`;
  }

  /** Opens a connection to the server listening on `port`. */
  connect(port: number): Promise<ByteChannel> {
    const listener = this.listening.get(port);
    if (!listener) {
      return Promise.reject(createSystemError("ECONNREFUSED", "connect"));
    }
    const { port1, port2 } = new MessageChannel();
    const channelId = this.nextChannelId++;
    const channel = createPortChannel(port2);
    this.channels.set(channelId, { ends: [0, listener.proc.id], kernelEnd: channel });
    listener.proc.channels.add(channelId);
    listener.proc.worker.postMessage(
      {
        type: "connection",
        listenerId: listener.listenerId,
        channelId,
        port: port1,
        remotePort: this.nextEphemeralPort++,
      },
      [port1],
    );
    return Promise.resolve(channel);
  }

  /** Ends every process and stops everything. */
  dispose(): void {
    this.disposed = true;
    for (const proc of Array.from(this.procs.values())) {
      this.stopWorker(proc);
    }
    this.procs.clear();
    for (const stop of this.pageWatches.values()) {
      stop();
    }
    this.pageWatches.clear();
    if (this.watchFlush) {
      clearTimeout(this.watchFlush);
    }
  }

  private flushWatchEvents(): void {
    this.watchFlush = null;
    const events = [...this.pendingWatchEvents.values()];
    this.pendingWatchEvents = new Map();
    for (const event of events) {
      this.host.emit(event);
    }
  }

  // -------------------------------------------------------------------------
  // Processes
  // -------------------------------------------------------------------------

  private startProcess(spec: {
    id: number;
    ppid: number;
    pgid: number;
    parent: Proc | null;
    reportTo: Proc | null;
    fds: Map<number, Description>;
    terminal: Terminal | null;
    pageOwned: boolean;
    resolved: { program: ProcessInit["program"]; argv: string[]; execArgv: string[] };
    env: Record<string, string>;
    cwd: string;
    ipc: MessagePort | null;
  }): Proc {
    const worker = this.host.createWorker(`webnode ${spec.id} ${spec.resolved.argv.join(" ")}`);
    const proc: Proc = {
      id: spec.id,
      pid: spec.id,
      ppid: spec.ppid,
      pgid: spec.pgid,
      owner: null,
      reportTo: spec.reportTo,
      threadId: 0,
      worker,
      argv: spec.resolved.argv,
      fds: spec.fds,
      syncBuffer: new SharedArrayBuffer(INITIAL_SYNC_BUFFER_BYTES),
      pendingAnswer: null,
      children: new Set(),
      threads: new Set(),
      terminal: spec.terminal,
      pageOwned: spec.pageOwned,
      handledSignals: new Set(),
      fsEntry: this.host.sharedFs?.admit() ?? null,
      watches: new Map(),
      pumps: new Map(),
      pendingReads: new Set(),
      listeners: new Map(),
      channels: new Set(),
      handoffs: new Map(),
      exitWaiters: [],
      exited: false,
    };
    this.procs.set(proc.id, proc);
    spec.parent?.children.add(proc.id);
    const stdin = spec.fds.get(0);
    if (stdin?.kind === "tty") {
      stdin.terminal.attach(proc.pid);
    }
    this.wire(proc);

    const terminalFds = [0, 1, 2].filter((fd) => spec.fds.get(fd)?.kind === "tty");
    const terminal = spec.terminal ?? this.anyTerminal(spec.fds);
    worker.postMessage(
      {
        type: "init",
        pid: proc.pid,
        ppid: proc.ppid,
        thread: null,
        program: spec.resolved.program,
        argv: spec.resolved.argv,
        execArgv: spec.resolved.execArgv,
        env: spec.env,
        cwd: spec.cwd,
        syncBuffer: proc.syncBuffer,
        sharedFs: this.admission(proc),
        ttyFds: terminalFds,
        terminal: terminal ? { cols: terminal.cols, rows: terminal.rows } : DEFAULT_TERMINAL,
        ipc: spec.ipc,
      },
      spec.ipc ? [spec.ipc] : [],
    );
    return proc;
  }

  private anyTerminal(fds: Map<number, Description>): Terminal | null {
    for (const fd of [0, 1, 2]) {
      const description = fds.get(fd);
      if (description?.kind === "tty") {
        return description.terminal;
      }
    }
    return null;
  }

  private wire(proc: Proc): void {
    proc.worker.onmessage = (event) => {
      if (!proc.exited) {
        this.onMessage(proc, event.data, event.ports);
      }
    };
    proc.worker.onerror = (event) => {
      event.preventDefault?.();
      if (proc.exited) {
        return;
      }
      try {
        this.writeToFd(proc, 2, new TextEncoder().encode(`${event.message ?? "worker error"}\n`));
      } catch {
        // Nowhere to report it (stderr closed or a broken pipe).
      }
      this.finish(proc.owner ?? proc, { code: 1, signal: null });
    };
  }

  private onMessage(proc: Proc, message: ProcessMessage, ports: readonly MessagePort[]): void {
    switch (message.type) {
      case "sync":
        this.runSync(proc, message.op, message.args);
        return;
      case "sync-buffer":
        proc.syncBuffer = message.buffer;
        if (proc.pendingAnswer) {
          const { ok, payload } = proc.pendingAnswer;
          proc.pendingAnswer = null;
          writeSyncAnswer(proc.syncBuffer, ok, payload);
        }
        return;
      case "call":
        this.runCall(proc, message.id, message.op, message.args);
        return;
      case "post":
        if (message.op === "handoff") {
          const [token, data] = message.args as [string, unknown];
          proc.handoffs.set(token, { port: ports[0], data });
          return;
        }
        try {
          this.dispatch(proc, message.op, message.args);
        } catch {
          // A post has nobody to report to.
        }
        return;
    }
  }

  private dispatch(proc: Proc, op: string, args: unknown[]): unknown {
    const handler = this.handlers[op];
    if (!handler) {
      throw new Error(`webnode kernel: unknown call "${op}"`);
    }
    return handler(proc, ...(args as never[]));
  }

  private runSync(proc: Proc, op: string, args: unknown[]): void {
    const answer = (ok: boolean, value: unknown) => {
      if (proc.exited) {
        return;
      }
      const payload = encodePayload(value);
      if (!writeSyncAnswer(proc.syncBuffer, ok, payload)) {
        proc.pendingAnswer = { ok, payload };
      }
    };
    const fail = (error: unknown) =>
      answer(false, serializeError(error, toSystemErrorRecord(error)));

    let result: unknown;
    try {
      result = this.dispatch(proc, op, args);
    } catch (error) {
      fail(error);
      return;
    }
    if (result instanceof Promise) {
      result.then((value) => answer(true, value), fail);
    } else {
      answer(true, result);
    }
  }

  private runCall(proc: Proc, id: number, op: string, args: unknown[]): void {
    const reply = (value: unknown) => {
      if (proc.exited) {
        return;
      }
      const transfer = value instanceof MessagePort ? [value] : [];
      const portValue =
        value !== null && typeof value === "object" && "port" in value
          ? (value as { port: unknown }).port
          : null;
      if (portValue instanceof MessagePort) {
        transfer.push(portValue);
      }
      proc.worker.postMessage({ type: "reply", id, ok: true, value }, transfer);
    };
    const fail = (error: unknown) => {
      if (!proc.exited) {
        proc.worker.postMessage({
          type: "reply",
          id,
          ok: false,
          error: serializeError(error, toSystemErrorRecord(error)),
        });
      }
    };
    try {
      const result = this.dispatch(proc, op, args);
      if (result instanceof Promise) {
        result.then(reply, fail);
      } else {
        reply(result);
      }
    } catch (error) {
      fail(error);
    }
  }

  /** Sends `signal` to process `pid`. Throws `ESRCH` when there is none. */
  private signal(pid: number, signal: string): void {
    const proc = this.procs.get(pid);
    if (!proc || proc.owner) {
      throw createSystemError("ESRCH", "kill");
    }
    if (signal === "0" || signal === "SIGCONT" || signal === "SIGWINCH") {
      return;
    }
    if (signal !== "SIGKILL" && signal !== "SIGSTOP" && proc.handledSignals.has(signal)) {
      proc.worker.postMessage({ type: "signal", signal });
      return;
    }
    // The default action: the signal ends the process, even one busy in a loop.
    this.finish(proc, { code: null, signal });
  }

  /**
   * Ctrl+C on a terminal: SIGINT to every process in the foreground process's
   * group, as a terminal does, so the other members of a pipeline stop too.
   */
  private interruptGroup(pid: number): void {
    const foreground = this.procs.get(pid);
    if (!foreground) {
      return;
    }
    const pgid = (foreground.owner ?? foreground).pgid;
    for (const proc of Array.from(this.procs.values())) {
      if (proc.owner || proc.exited || proc.pgid !== pgid) {
        continue;
      }
      try {
        this.signal(proc.pid, "SIGINT");
      } catch {
        // Gone in the meantime.
      }
    }
  }

  /** A write to a pipe nobody reads: SIGPIPE to the writer, whose default action ends it. */
  private brokenPipe(proc: Proc): void {
    const process = proc.owner ?? proc;
    if (process.exited) {
      return;
    }
    try {
      this.signal(process.pid, "SIGPIPE");
    } catch {
      // Not a process of ours (a kernel-side write).
    }
  }

  /** Stops what one worker (a process or a thread) holds outside its file descriptors. */
  private releaseResources(proc: Proc): void {
    for (const stop of proc.watches.values()) {
      stop();
    }
    proc.watches.clear();
    for (const stop of proc.pumps.values()) {
      stop();
    }
    proc.pumps.clear();
    for (const cancel of Array.from(proc.pendingReads)) {
      cancel();
    }
    proc.pendingReads.clear();
    for (const channelId of Array.from(proc.channels)) {
      this.dropChannel(channelId, proc.id);
    }
    proc.channels.clear();
    for (const [listenerId, port] of Array.from(proc.listeners)) {
      this.closeListener(proc, listenerId, port);
    }
    for (const handoff of proc.handoffs.values()) {
      handoff.port?.close();
    }
    proc.handoffs.clear();
  }

  /** What `proc`'s worker needs to call the shared filesystem itself, or null. */
  private admission(proc: Proc): ProcessInit["sharedFs"] {
    const shared = this.host.sharedFs;
    return shared && proc.fsEntry
      ? { module: shared.module, memory: shared.memory, ...proc.fsEntry }
      : null;
  }

  /**
   * Terminates `proc`'s worker. One that was admitted to the shared filesystem
   * is retired from it first: terminated inside a call, it would die holding
   * the lock every other worker waits for.
   */
  private stopWorker(proc: Proc): void {
    const shared = this.host.sharedFs;
    const entry = proc.fsEntry;
    if (shared && entry) {
      proc.fsEntry = null;
      shared.retire(entry.slot, () => proc.worker.terminate());
      // It may have left events it never told the kernel about; left there,
      // they would also keep the next writer from announcing its own.
      try {
        shared.fs.drainEvents();
      } catch {
        // The filesystem is poisoned: there is nothing to deliver.
      }
    } else {
      proc.worker.terminate();
    }
  }

  /** Ends `proc`: stops its worker, closes what it held, and tells who waits for it. */
  private finish(proc: Proc, status: ExitStatus): void {
    if (proc.exited) {
      return;
    }
    proc.exited = true;
    this.stopWorker(proc);
    proc.worker.onmessage = null;
    this.procs.delete(proc.id);
    this.releaseResources(proc);

    if (proc.owner) {
      // A thread: its process keeps the file descriptors.
      proc.owner.threads.delete(proc);
      if (!proc.owner.exited) {
        proc.owner.worker.postMessage({
          type: "thread-exit",
          threadId: proc.threadId,
          code: status.code ?? 1,
        });
      }
      return;
    }

    for (const thread of Array.from(proc.threads)) {
      thread.exited = true;
      this.stopWorker(thread);
      thread.worker.onmessage = null;
      this.procs.delete(thread.id);
      this.releaseResources(thread);
    }
    proc.threads.clear();
    for (const fd of Array.from(proc.fds.keys())) {
      this.closeFd(proc, fd);
    }
    proc.terminal?.detach(proc.pid);

    const parent = this.procs.get(proc.ppid);
    // Children it leaves behind go to its parent, so `killTree` still reaches them.
    for (const childId of Array.from(proc.children)) {
      const child = this.procs.get(childId);
      if (!child) {
        continue;
      }
      child.reportTo = null;
      if (parent) {
        child.ppid = parent.pid;
        parent.children.add(child.id);
      }
    }
    proc.children.clear();

    parent?.children.delete(proc.id);
    const reportTo = proc.reportTo;
    if (reportTo && !reportTo.exited) {
      reportTo.worker.postMessage({ type: "child-exit", pid: proc.pid, status });
    }
    for (const waiter of proc.exitWaiters) {
      waiter(status);
    }
    if (proc.pageOwned && !this.disposed) {
      const signalNumber = status.signal ? (SIGNAL_NUMBERS[status.signal] ?? 0) : 0;
      this.host.emit({ event: "exit", pid: proc.pid, code: status.code ?? 128 + signalNumber });
    }
  }

  // -------------------------------------------------------------------------
  // File descriptors
  // -------------------------------------------------------------------------

  private allocateFd(proc: Proc, description: Description): number {
    let fd = 3;
    while (proc.fds.has(fd)) {
      fd += 1;
    }
    proc.fds.set(fd, description);
    return fd;
  }

  private description(proc: Proc, fd: number, syscall: string): Description {
    const description = proc.fds.get(fd);
    if (!description) {
      throw createSystemError("EBADF", syscall);
    }
    return description;
  }

  private closeFd(proc: Proc, fd: number): void {
    const description = proc.fds.get(fd);
    if (!description) {
      return;
    }
    proc.fds.delete(fd);
    proc.pumps.get(fd)?.();
    proc.pumps.delete(fd);
    this.release(description);
  }

  private release(description: Description): void {
    description.refs -= 1;
    if (description.refs > 0) {
      return;
    }
    if (description.kind === "file") {
      description.file.close();
    } else if (description.kind === "pipe-read") {
      description.pipe.removeReader();
    } else if (description.kind === "pipe-write") {
      description.pipe.removeWriter();
    }
  }

  private source(description: Description): ByteSource | null {
    if (description.kind === "pipe-read") {
      return description.pipe;
    }
    if (description.kind === "tty") {
      return description.terminal;
    }
    return null;
  }

  private writeToFd(proc: Proc, fd: number, data: Uint8Array): number {
    const description = this.description(proc, fd, "write");
    switch (description.kind) {
      case "file":
        return description.file.write(data, null);
      case "pipe-write":
        if (!description.pipe.hasReaders) {
          // As write(2): SIGPIPE first (ending a writer that does not handle it), then EPIPE.
          this.brokenPipe(proc);
          throw createSystemError("EPIPE", "write");
        }
        description.pipe.write(data.slice());
        return data.byteLength;
      case "tty":
        description.terminal.write(data);
        return data.byteLength;
      case "null":
        return data.byteLength;
      default:
        throw createSystemError("EBADF", "write");
    }
  }

  /** Opens the device files the kernel provides, or null for an ordinary path. */
  private openDevice(proc: Proc, path: string): Description | null {
    switch (path) {
      case "/dev/null":
        return { kind: "null", refs: 1 };
      case "/dev/stdin":
      case "/dev/stdout":
      case "/dev/stderr": {
        const description = proc.fds.get(
          ["/dev/stdin", "/dev/stdout", "/dev/stderr"].indexOf(path),
        );
        if (!description) {
          throw createSystemError("ENOENT", "open", path);
        }
        description.refs += 1;
        return description;
      }
      case "/dev/tty": {
        const terminal = proc.terminal ?? this.anyTerminal(proc.fds);
        if (!terminal) {
          throw createSystemError("ENXIO", "open", path);
        }
        return { kind: "tty", refs: 1, terminal, output: true };
      }
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Spawning from a process
  // -------------------------------------------------------------------------

  private spawnChild(
    parent: Proc,
    request: SpawnRequest,
    ipcToken: string | null,
    capture?: Capture,
  ): { proc: Proc; stdio: (number | null)[] } {
    const process = parent.owner ?? parent;
    // The ipc port posted ahead of this spawn is taken first, so a failed spawn does not leave it behind.
    const handoff = ipcToken
      ? (parent.handoffs.get(ipcToken) ?? process.handoffs.get(ipcToken))
      : undefined;
    if (ipcToken) {
      parent.handoffs.delete(ipcToken);
      process.handoffs.delete(ipcToken);
    }
    let resolved: ReturnType<typeof resolveExec>;
    try {
      resolved = resolveExec(this.vfs, request.command, request.args, request.env, request.cwd);
    } catch (error) {
      handoff?.port?.close();
      throw error;
    }
    if (request.argv0 && resolved.program !== "shell") {
      resolved.argv[0] = request.argv0;
    }

    const fds = new Map<number, Description>();
    const parentFds: (number | null)[] = [];
    const stdio: StdioSpec[] = [...request.stdio];
    while (stdio.length < 3) {
      stdio.push("pipe");
    }

    stdio.forEach((spec, fd) => {
      parentFds[fd] = null;
      if (spec === "ignore") {
        fds.set(fd, { kind: "null", refs: 1 });
        return;
      }
      if (spec === "ipc") {
        return;
      }
      if (spec === "inherit" || typeof spec === "number") {
        const source = process.fds.get(spec === "inherit" ? fd : spec);
        if (!source) {
          fds.set(fd, { kind: "null", refs: 1 });
          return;
        }
        source.refs += 1;
        fds.set(fd, source);
        return;
      }

      // "pipe": the child's stdin is the read end, its other fds the write end.
      const pipe = new Pipe();
      pipe.addReader();
      pipe.addWriter();
      const childEnd: Description =
        fd === 0 ? { kind: "pipe-read", refs: 1, pipe } : { kind: "pipe-write", refs: 1, pipe };
      const parentEnd: Description =
        fd === 0 ? { kind: "pipe-write", refs: 1, pipe } : { kind: "pipe-read", refs: 1, pipe };
      fds.set(fd, childEnd);

      if (!capture) {
        parentFds[fd] = this.allocateFd(process, parentEnd);
      } else if (fd === 0) {
        if (capture.input) {
          pipe.write(capture.input);
        }
        this.release(parentEnd);
      } else if (fd === 1 || fd === 2) {
        this.drain(pipe, fd === 1 ? capture.stdout : capture.stderr, capture);
      } else {
        this.release(parentEnd);
      }
    });

    const stdin = fds.get(0);
    const id = this.nextId++;
    const proc = this.startProcess({
      id,
      ppid: process.pid,
      pgid: request.newGroup ? id : process.pgid,
      parent: process,
      // spawnSync collects the exit itself; a spawn reports it to the worker that asked.
      reportTo: capture ? null : parent,
      fds,
      terminal: stdin?.kind === "tty" ? stdin.terminal : null,
      pageOwned: false,
      resolved,
      env: request.env,
      cwd: request.cwd,
      ipc: handoff?.port ?? null,
    });
    return { proc, stdio: parentFds };
  }

  /**
   * Collects everything written to `pipe` into `chunks` until it ends, or
   * until `capture.maxBuffer` bytes, when it keeps that much and reports the overflow.
   */
  private drain(pipe: Pipe, chunks: Uint8Array[], capture: Capture): void {
    const limit = capture.maxBuffer ?? Infinity;
    let total = 0;
    const pump = () => {
      for (;;) {
        const chunk = pipe.take(Number.MAX_SAFE_INTEGER);
        if (chunk === null) {
          pipe.removeReader();
          return;
        }
        if (chunk === undefined) {
          pipe.whenReadable(0, pump);
          return;
        }
        if (total + chunk.byteLength > limit) {
          chunks.push(chunk.subarray(0, limit - total));
          total = limit;
          pipe.removeReader();
          capture.onOverflow?.();
          return;
        }
        total += chunk.byteLength;
        chunks.push(chunk);
      }
    };
    pump();
  }

  private spawnSync(parent: Proc, request: SpawnSyncRequest): Promise<SpawnSyncResult> {
    const capture: Capture = {
      stdout: [],
      stderr: [],
      input: request.input,
      maxBuffer:
        typeof request.maxBuffer === "number" && request.maxBuffer >= 0
          ? request.maxBuffer
          : undefined,
    };
    let child: Proc;
    try {
      child = this.spawnChild(parent, request, null, capture).proc;
    } catch (error) {
      const record = toSystemErrorRecord(error);
      if (!record) {
        throw error;
      }
      return Promise.resolve({
        pid: 0,
        status: { code: null, signal: null },
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        error: record,
      });
    }

    return new Promise((resolve) => {
      let timedOut = false;
      let overflowed = false;
      capture.onOverflow = () => {
        if (!overflowed && !timedOut) {
          overflowed = true;
          this.killTree(child.pid);
        }
      };
      const timer =
        request.timeoutMs && request.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              this.killTree(child.pid);
            }, request.timeoutMs)
          : null;
      child.exitWaiters.push((status) => {
        if (timer) {
          clearTimeout(timer);
        }
        // The pipes drain in the same turn the child's descriptors close.
        queueMicrotask(() => {
          const killed = timedOut || overflowed;
          const result: SpawnSyncResult = {
            pid: child.pid,
            status: killed ? { code: null, signal: request.killSignal ?? "SIGTERM" } : status,
            stdout: concat(capture.stdout),
            stderr: concat(capture.stderr),
          };
          if (timedOut) {
            result.error = "ETIMEDOUT";
          } else if (overflowed) {
            result.error = "ENOBUFS";
          }
          resolve(result);
        });
      });
    });
  }

  private spawnThread(parent: Proc, request: ThreadSpawnRequest, token: string): number {
    const process = parent.owner ?? parent;
    const handoff = process.handoffs.get(token) ?? parent.handoffs.get(token);
    process.handoffs.delete(token);
    parent.handoffs.delete(token);
    if (!handoff) {
      throw new Error("webnode kernel: a worker thread was started without its port");
    }

    const id = this.nextId++;
    const worker = this.host.createWorker(`webnode ${process.pid} thread ${request.name || id}`);
    const thread: Proc = {
      id,
      pid: process.pid,
      ppid: process.ppid,
      pgid: process.pgid,
      owner: process,
      reportTo: null,
      threadId: id,
      worker,
      argv: request.argv,
      fds: process.fds,
      syncBuffer: new SharedArrayBuffer(INITIAL_SYNC_BUFFER_BYTES),
      pendingAnswer: null,
      children: process.children,
      threads: new Set(),
      terminal: process.terminal,
      pageOwned: false,
      handledSignals: new Set(),
      fsEntry: this.host.sharedFs?.admit() ?? null,
      watches: new Map(),
      pumps: new Map(),
      pendingReads: new Set(),
      listeners: new Map(),
      channels: new Set(),
      handoffs: new Map(),
      exitWaiters: [],
      exited: false,
    };
    this.procs.set(id, thread);
    process.threads.add(thread);
    this.wire(thread);

    const terminal = this.anyTerminal(process.fds);
    worker.postMessage(
      {
        type: "init",
        pid: process.pid,
        ppid: process.ppid,
        thread: {
          threadId: id,
          filename: request.filename,
          eval: request.eval,
          workerData: handoff.data,
          port: handoff.port,
          name: request.name,
        },
        program: "node",
        argv: request.argv,
        execArgv: request.execArgv,
        env: request.env,
        cwd: request.cwd,
        syncBuffer: thread.syncBuffer,
        sharedFs: this.admission(thread),
        ttyFds: [0, 1, 2].filter((fd) => process.fds.get(fd)?.kind === "tty"),
        terminal: terminal ? { cols: terminal.cols, rows: terminal.rows } : DEFAULT_TERMINAL,
        ipc: null,
      },
      [handoff.port],
    );
    return id;
  }

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------

  private listen(proc: Proc, port: number): { port: number; listenerId: number } {
    let chosen = port;
    if (chosen === 0) {
      do {
        chosen = this.nextEphemeralPort++;
      } while (this.listening.has(chosen));
    } else if (this.listening.has(chosen)) {
      const error = createSystemError("EADDRINUSE", "listen");
      error.port = chosen;
      error.address = "0.0.0.0";
      throw error;
    }
    const listenerId = this.nextListenerId++;
    this.listening.set(chosen, { proc, listenerId });
    proc.listeners.set(listenerId, chosen);
    this.host.emit({ event: "port", port: chosen, type: "open" });
    return { port: chosen, listenerId };
  }

  private closeListener(proc: Proc, listenerId: number, port: number): void {
    proc.listeners.delete(listenerId);
    if (this.listening.get(port)?.listenerId === listenerId) {
      this.listening.delete(port);
      if (!this.disposed) {
        this.host.emit({ event: "port", port, type: "close" });
      }
    }
  }

  private connectFromProcess(
    proc: Proc,
    port: number,
  ): { port: MessagePort; channelId: number; localPort: number } {
    const listener = this.listening.get(port);
    if (!listener) {
      const error = createSystemError("ECONNREFUSED", "connect");
      error.port = port;
      error.address = "127.0.0.1";
      throw error;
    }
    const { port1, port2 } = new MessageChannel();
    const channelId = this.nextChannelId++;
    const localPort = this.nextEphemeralPort++;
    this.channels.set(channelId, { ends: [proc.id, listener.proc.id], kernelEnd: null });
    proc.channels.add(channelId);
    listener.proc.channels.add(channelId);
    listener.proc.worker.postMessage(
      {
        type: "connection",
        listenerId: listener.listenerId,
        channelId,
        port: port1,
        remotePort: localPort,
      },
      [port1],
    );
    return { port: port2, channelId, localPort };
  }

  /** Forgets a connection one end of which (`goneId`) is gone, and tells the other end. */
  private dropChannel(channelId: number, goneId: number): void {
    const channel = this.channels.get(channelId);
    if (!channel) {
      return;
    }
    this.channels.delete(channelId);
    for (const end of channel.ends) {
      if (end === goneId) {
        continue;
      }
      if (end === 0) {
        channel.kernelEnd?.kill();
      } else {
        const peer = this.procs.get(end);
        peer?.channels.delete(channelId);
        peer?.worker.postMessage({ type: "channel-dead", channelId });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The calls processes make
  // -------------------------------------------------------------------------

  private createHandlers(): Record<string, Handler> {
    const vfs = this.vfs;
    const handlers = {
      // Paths
      "fs.stat": (_proc: Proc, path: string, follow: boolean) => vfs.stat(path, follow),
      "fs.exists": (_proc: Proc, path: string) => vfs.exists(path),
      "fs.readdir": (_proc: Proc, path: string) => vfs.readdir(path),
      "fs.mkdir": (_proc: Proc, path: string, recursive: boolean, mode: number) =>
        vfs.mkdir(path, recursive, mode),
      "fs.rmdir": (_proc: Proc, path: string) => vfs.rmdir(path),
      "fs.unlink": (_proc: Proc, path: string) => vfs.unlink(path),
      "fs.rm": (_proc: Proc, path: string, recursive: boolean, force: boolean) =>
        vfs.rm(path, recursive, force),
      "fs.rename": (_proc: Proc, from: string, to: string) => vfs.rename(from, to),
      "fs.link": (_proc: Proc, existing: string, path: string) => vfs.link(existing, path),
      "fs.symlink": (_proc: Proc, target: string, path: string) => vfs.symlink(target, path),
      "fs.readlink": (_proc: Proc, path: string) => vfs.readlink(path),
      "fs.realpath": (_proc: Proc, path: string) => vfs.realpath(path),
      "fs.chmod": (_proc: Proc, path: string, mode: number, follow: boolean) =>
        vfs.chmod(path, mode, follow),
      "fs.utimes": (_proc: Proc, path: string, atime: number, mtime: number, follow: boolean) =>
        vfs.utimes(path, atime, mtime, follow),
      "fs.truncate": (_proc: Proc, path: string, length: number) => vfs.truncate(path, length),
      "fs.copyFile": (_proc: Proc, source: string, destination: string, mode: number) =>
        vfs.copyFile(source, destination, mode),
      "fs.access": (_proc: Proc, path: string, mode: number) => vfs.access(path, mode),
      "fs.mkdtemp": (_proc: Proc, prefix: string) => vfs.mkdtemp(prefix),
      "fs.readFile": (_proc: Proc, path: string) => vfs.readFile(path),
      "fs.writeFile": (
        _proc: Proc,
        path: string,
        data: Uint8Array,
        flags: number,
        mode: number,
      ) => {
        if (path === "/dev/null") {
          return;
        }
        vfs.writeFile(path, data, flags, mode);
      },

      // Descriptors
      "fs.open": (proc: Proc, path: string, flags: number, mode: number) => {
        const device = this.openDevice(proc, path);
        return this.allocateFd(
          proc,
          device ?? { kind: "file", refs: 1, file: vfs.open(path, flags, mode) },
        );
      },
      "fs.close": (proc: Proc, fd: number) => {
        this.description(proc, fd, "close");
        this.closeFd(proc, fd);
      },
      "fs.read": (proc: Proc, fd: number, length: number, position: number | null) => {
        const description = this.description(proc, fd, "read");
        if (description.kind === "file") {
          return description.file.read(length, position);
        }
        const source = this.source(description);
        if (!source) {
          return new Uint8Array(0);
        }
        return this.readSource(proc, source, length);
      },
      "fs.write": (proc: Proc, fd: number, data: Uint8Array, position: number | null) => {
        const description = this.description(proc, fd, "write");
        if (description.kind === "file") {
          return description.file.write(data, position);
        }
        return this.writeToFd(proc, fd, data);
      },
      "fs.fstat": (proc: Proc, fd: number) => {
        const description = this.description(proc, fd, "fstat");
        if (description.kind === "file") {
          return description.file.stat();
        }
        return streamStat(
          description.kind === "tty" || description.kind === "null"
            ? S_IFCHR | 0o620
            : S_IFIFO | 0o600,
        );
      },
      "fs.ftruncate": (proc: Proc, fd: number, length: number) =>
        this.file(proc, fd, "ftruncate").truncate(length),
      "fs.fchmod": (proc: Proc, fd: number, mode: number) =>
        this.file(proc, fd, "fchmod").chmod(mode),
      "fs.futimes": (proc: Proc, fd: number, atime: number, mtime: number) =>
        this.file(proc, fd, "futime").utimes(atime, mtime),
      "fs.fsync": (proc: Proc, fd: number) => {
        this.description(proc, fd, "fsync");
      },
      "fs.watch": (proc: Proc, path: string, recursive: boolean) => {
        const watchId = this.nextWatchId++;
        const stop = vfs.watch(path, recursive, (event) => {
          proc.worker.postMessage({
            type: "watch",
            watchId,
            eventType: event.eventType,
            filename: relativeName(path, event.path),
          });
        });
        proc.watches.set(watchId, stop);
        return watchId;
      },
      // A process changed the tree itself and left events for the watchers.
      "fs.changed": () => {
        this.host.sharedFs?.fs.drainEvents();
      },
      "fs.unwatch": (proc: Proc, watchId: number) => {
        proc.watches.get(watchId)?.();
        proc.watches.delete(watchId);
      },

      // Streams on descriptors
      "fd.kind": (proc: Proc, fd: number) => {
        const description = proc.fds.get(fd);
        if (!description) {
          throw createSystemError("EBADF", "fstat");
        }
        return description.kind === "pipe-read" || description.kind === "pipe-write"
          ? "pipe"
          : description.kind;
      },
      "fd.readStart": (proc: Proc, fd: number) => {
        const description = this.description(proc, fd, "read");
        const source = this.source(description);
        if (!source || proc.pumps.has(fd)) {
          if (!source) {
            proc.worker.postMessage({ type: "fd-data", fd, chunk: null });
          }
          return;
        }
        let cancelWait: (() => void) | null = null;
        let stopped = false;
        const pump = () => {
          cancelWait = null;
          while (!stopped) {
            const chunk = source.take(65536, proc.pid);
            if (chunk === undefined) {
              cancelWait = source.whenReadable(proc.pid, pump);
              return;
            }
            proc.worker.postMessage({ type: "fd-data", fd, chunk });
            if (chunk === null) {
              proc.pumps.delete(fd);
              return;
            }
          }
        };
        proc.pumps.set(fd, () => {
          stopped = true;
          cancelWait?.();
        });
        pump();
      },
      "fd.readStop": (proc: Proc, fd: number) => {
        proc.pumps.get(fd)?.();
        proc.pumps.delete(fd);
      },
      "fd.write": (proc: Proc, fd: number, chunk: Uint8Array) => {
        this.writeToFd(proc, fd, chunk);
      },
      "fd.close": (proc: Proc, fd: number) => this.closeFd(proc, fd),

      // Terminals
      "tty.setRawMode": (proc: Proc, fd: number, enabled: boolean) => {
        const description = this.description(proc, fd, "ioctl");
        if (description.kind !== "tty") {
          throw createSystemError("ENOTTY", "ioctl");
        }
        description.terminal.raw = enabled;
      },

      // Processes
      "proc.spawn": (proc: Proc, request: SpawnRequest, ipcToken: string | null) => {
        const { proc: child, stdio } = this.spawnChild(proc, request, ipcToken);
        return { pid: child.pid, stdio };
      },
      "proc.spawnSync": (proc: Proc, request: SpawnSyncRequest) => this.spawnSync(proc, request),
      "proc.kill": (_proc: Proc, pid: number, signal: string) => this.signal(pid, signal),
      "proc.exit": (proc: Proc, code: number) => {
        // From a thread this ends the thread; from a process, the process.
        this.finish(proc, { code, signal: null });
        // No answer: the worker is gone.
        return new Promise(() => {});
      },
      "proc.die": (proc: Proc, signal: string) => {
        this.finish(proc.owner ?? proc, { code: null, signal });
        return new Promise(() => {});
      },
      "proc.signals": (proc: Proc, signals: string[]) => {
        // Signals go to a process's main thread; a worker thread's set says nothing about it.
        if (!proc.owner) {
          proc.handledSignals = new Set(signals);
        }
      },
      "proc.setpgid": (proc: Proc, pgid: number) => {
        // setpgid(0, pgid): 0 starts a group of its own, as a shell does for each job.
        const process = proc.owner ?? proc;
        process.pgid = pgid > 0 ? pgid : process.pid;
      },
      "proc.pipe": (proc: Proc) => {
        const pipe = new Pipe();
        pipe.addReader();
        pipe.addWriter();
        return {
          readFd: this.allocateFd(proc, { kind: "pipe-read", refs: 1, pipe }),
          writeFd: this.allocateFd(proc, { kind: "pipe-write", refs: 1, pipe }),
        };
      },
      "proc.list": () =>
        [...this.procs.values()]
          .filter((proc) => !proc.owner)
          .map((proc) => ({ pid: proc.pid, ppid: proc.ppid, argv: proc.argv })),

      // Threads
      "thread.spawn": (proc: Proc, request: ThreadSpawnRequest, token: string) =>
        this.spawnThread(proc, request, token),
      "thread.terminate": (_proc: Proc, threadId: number) => {
        const thread = this.procs.get(threadId);
        if (thread?.owner) {
          this.finish(thread, { code: 1, signal: null });
        }
      },

      // Network
      "net.listen": (proc: Proc, port: number) => this.listen(proc, port),
      "net.close": (proc: Proc, listenerId: number) => {
        const port = proc.listeners.get(listenerId);
        if (port !== undefined) {
          this.closeListener(proc, listenerId, port);
        }
      },
      "net.connect": (proc: Proc, port: number) => this.connectFromProcess(proc, port),
      "net.closed": (proc: Proc, channelId: number) => {
        proc.channels.delete(channelId);
        const channel = this.channels.get(channelId);
        if (channel && channel.ends.every((end) => !this.procs.get(end)?.channels.has(channelId))) {
          this.channels.delete(channelId);
        }
      },
    };
    return handlers as unknown as Record<string, Handler>;
  }

  private file(proc: Proc, fd: number, syscall: string): OpenFile {
    const description = this.description(proc, fd, syscall);
    if (description.kind !== "file") {
      throw createSystemError("EINVAL", syscall);
    }
    return description.file;
  }

  /**
   * Takes bytes from `source` for `proc`, waiting for them when none are
   * buffered. The wait is cancelled if `proc` ends first, so a dead reader never takes bytes.
   */
  private readSource(
    proc: Proc,
    source: ByteSource,
    length: number,
  ): Uint8Array | Promise<Uint8Array> {
    const reader = proc.pid;
    const chunk = source.take(length, reader);
    if (chunk !== undefined) {
      return chunk ?? new Uint8Array(0);
    }
    return new Promise((resolve) => {
      let cancelWait = () => {};
      const cancel = () => cancelWait();
      const retry = () => {
        const next = source.take(length, reader);
        if (next === undefined) {
          cancelWait = source.whenReadable(reader, retry);
        } else {
          proc.pendingReads.delete(cancel);
          resolve(next ?? new Uint8Array(0));
        }
      };
      cancelWait = source.whenReadable(reader, retry);
      proc.pendingReads.add(cancel);
    });
  }
}

/** `path` relative to the watched `root`; the root itself is its own last segment. */
function relativeName(root: string, path: string): string {
  if (path === root) {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

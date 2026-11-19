// The kernel: the one place that owns what processes share. It holds the
// filesystem, the process table, every file descriptor, pipe and terminal, and
// the table of listening ports, and it answers the calls process workers make
// (process/sysClient.ts is the other end). It runs inside the kernel worker;
// workers are created through `KernelHost` so tests can drive it without any.
import { createPortChannel } from "../byteChannel";
import { createSystemError, toSystemErrorRecord } from "../errors";
import {
  DEFAULT_PATH,
  GID,
  HOME_DIR,
  HOSTNAME,
  SHELL_PATH,
  TMP_DIR,
  UID,
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
import {
  INITIAL_SYNC_BUFFER_BYTES,
  SYNC_BROKEN,
  SYNC_HEADER_BYTES,
  serializeError,
} from "../protocol";
import { encodePayload, writeSyncAnswer } from "./codec";
import type { EncodedPayload } from "./codec";
import { installBuiltinCommands, resolveExec } from "./exec";
import { createPageFiles } from "./pageFiles";
import type { PageFiles } from "./pageFiles";
import { PreparedModules, prepareInWorker } from "./preparedModules";
import type { PreparedStore } from "./preparedModules";
import type { ByteSource } from "./streams";
import { Delivery, Pipe, PIPE_CAPACITY, Terminal, TerminalDelivery } from "./streams";
import type { SharedFilesystem } from "../sharedfs/boot";
import { isDeviceEntry, kernelPathOf } from "../sharedfs/processBackend";
import { DEVICE_NAMES, deviceFd, deviceOf, walkDevicePath, type DeviceWalk } from "./devicePaths";
import { endsByDefault, exitStatusNumber } from "../signals";
import { createUmaskCell, DEFAULT_UMASK, readUmask, type UmaskCell } from "../umask";
import type { OpenFile, PermissionedVfs, StatData } from "./vfs/types";
import {
  accessBits,
  callerBits,
  COPYFILE_EXCL,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW,
  O_TRUNC,
  O_WRONLY,
  OWNER_W,
  ROOT_ID,
  S_IFCHR,
  S_IFDIR,
  S_IFIFO,
} from "./vfs/types";

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
  /** Where large modules' entries are kept between visits (preparedModules.ts); null or left out: nowhere. */
  preparedStore?: PreparedStore | null;
}

/**
 * How a write to a full pipe waits. "wait" is a blocking write(2): answered
 * once every byte is in, and withdrawn if its process dies first. "queue" is
 * a write with a completion (or none): answered the same way, but the bytes
 * were handed over, so they still go in after their process has gone.
 */
type WriteMode = "wait" | "queue";

/** Bytes a pump sends a reading process in one message at most: a pipeful. */
const DELIVERY_BYTES = PIPE_CAPACITY;

/** What a wait the kernel gives up on (its process ended) settles with; nobody hears it. */
function processGone(): Error {
  return new Error("webnode kernel: the process ended");
}

/** A pump: a stream of `fd-data` messages for one fd (`fd.readStart`). */
interface Pump {
  stop(): void;
  /**
   * Stops for as long as its worker waits in a blocking call (see
   * `Kernel.holdDeliveries`): it withdraws its wait to read and sends
   * nothing until `resume`. The worker cannot receive, so it must not count
   * as a reader waiting for a terminal's input, nor be sent a pipe's bytes.
   */
  pause(): void;
  /** Delivers again after a pause. */
  resume(): void;
  /** The worker received all the pump had sent: the next delivery may go, unless paused. */
  next(): void;
}

/** A read waiting for bytes from a pipe or a terminal. */
interface PendingRead {
  /** The name the worker gave the read, when it may give it up itself (`fs.readCancel`). */
  token: number | undefined;
  /** Withdraws the wait, so the read takes nothing, and fails the read with `error`. */
  giveUp(error: Error): void;
}

/** The descriptors above 2 of a process's table, lowest first: what a new process inherits beyond its stdio. */
function descriptorsAbove2(fds: Map<number, unknown>): number[] {
  return [...fds.keys()].filter((fd) => fd > 2).sort((a, b) => a - b);
}

/** Swallows the failure of a result nobody waits for (a post's). */
function settleQuietly(result: unknown): void {
  if (result instanceof Promise) {
    result.catch(() => {});
  }
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
  /**
   * The pids of the processes that started this one, the first one first
   * (its parent's last): who it descends from once a parent has ended and
   * left it to another (`tty.reclaim`).
   */
  lineage: number[];
  /**
   * The first process this one started in its own group since it last took
   * the terminal back (`tty.reclaim`), or null when it started none: the
   * process group a shell with job control gives its foreground job.
   */
  foregroundJob: number | null;
  /** For a thread: the process it belongs to. */
  owner: Proc | null;
  /**
   * The process or thread that started this process and hears its
   * `child-exit` (for a thread: its `thread-exit`); null for none.
   */
  reportTo: Proc | null;
  threadId: number;
  worker: KernelWorker;
  argv: string[];
  /** Shared by a process and its threads. */
  fds: Map<number, Description>;
  /**
   * The file mode creation mask, shared by a process and its threads. The
   * process sets it there itself; what the kernel creates for it is masked
   * by what it holds at that moment (`creating`).
   */
  umask: UmaskCell;
  syncBuffer: SharedArrayBuffer;
  pendingAnswer: { ok: boolean; payload: EncodedPayload } | null;
  children: Set<number>;
  threads: Set<Proc>;
  /**
   * The controlling terminal: the one of the page process this one descends
   * from, whatever its own stdio is. /dev/tty opens it.
   */
  terminal: Terminal | null;
  pageOwned: boolean;
  handledSignals: Set<string>;
  /** This worker's slot in the shared filesystem, while it holds one. */
  fsEntry: { slot: number; token: number } | null;
  watches: Map<number, () => void>;
  pumps: Map<number, Pump>;
  /**
   * The reads of a pipe or terminal this worker is waiting in. Each is given
   * up when the worker ends, and settles then, so whatever the read holds (a
   * device's reference) is let go.
   */
  pendingReads: Set<PendingRead>;
  /** Withdraws and settles each blocking write this worker is waiting in, for when it dies first. */
  pendingWrites: Set<() => void>;
  /** Per fd this worker reads from a pipe with `fd.readStart`: what is on its way (`fd.ack`). */
  deliveries: Map<number, Delivery>;
  /** The same per fd it reads from a terminal: what it has not said it handed to its reader. */
  typed: Map<number, TerminalDelivery>;
  /**
   * How often a pipe this worker writes to lost its readers. Mirrored in its
   * sync buffer (`SYNC_BROKEN`), where the worker sees it without asking.
   */
  broken: number;
  /** Listener id → port. */
  listeners: Map<number, number>;
  channels: Set<number>;
  /** Ports posted ahead of a blocking spawn, by token. */
  /**
   * What a process handed over for a spawn: the new worker's port, `data`,
   * and the other ports that came with it, which are inside `data`.
   */
  handoffs: Map<string, { port: MessagePort; data: unknown; carried: MessagePort[] }>;
  /** Who waits for this process's exit: told at its end, or when it goes on as a new process. */
  exitWaiters: ((status: ExitStatus) => void)[];
  /** What to do when the worker ends: not when it goes on as a new process (`forkAndExit`). */
  endWaiters: (() => void)[];
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
  /**
   * The kernel's read ends of the stdout and stderr pipes still open, each
   * as the function that drops it without waiting for the pipe's end.
   */
  readEnds: Set<() => void>;
  /** Runs when a read end has been dropped: its pipe ended, or the kernel let go of it. */
  onReadEnd?: () => void;
  /** The child's stdin closed before it took all of `input`. */
  inputBroken?: boolean;
}

interface Listener {
  proc: Proc;
  listenerId: number;
  /** The timer that will tell the page the port is open; null once it has. */
  announce: ReturnType<typeof setTimeout> | null;
}

/**
 * How long a listener must stay before the page is told its port is open. A
 * tool that only asks whether a port is free listens and closes at once (Vite
 * does, three times, a fifth of a second before its server listens). Telling
 * the page of that would send a preview to a port nothing listens on by the
 * time its request arrives.
 */
const PORT_ANNOUNCE_DELAY_MS = 50;

interface Channel {
  /** Worker ids at each end; 0 is the kernel itself. */
  ends: [number, number];
  /** The kernel's own end, when it has one. */
  kernelEnd: { kill(): void } | null;
}

const DEFAULT_TERMINAL: TerminalSize = { cols: 80, rows: 24 };
/** The most a spawnSync capture takes from its pipe in one read: Node's read buffer. */
const SPAWN_SYNC_READ_BYTES = 65536;
/** The ephemeral range Linux and Node use: listen(0) picks from it, and connections are labelled from it. */
const EPHEMERAL_PORT_START = 49152;
const EPHEMERAL_PORT_END = 65535;
const WATCH_BATCH_MS = 16;

type Handler = (proc: Proc, ...args: never[]) => unknown;

function isLinkLoop(error: unknown): boolean {
  return toSystemErrorRecord(error)?.code === "ELOOP";
}

/** The stat a pipe, terminal or device reports: the user's, or root's (`ROOT_ID`). */
function streamStat(mode: number, owner = UID): StatData {
  const now = Date.now();
  return {
    dev: 2,
    ino: 0,
    mode,
    nlink: 1,
    uid: owner,
    gid: owner === UID ? GID : owner,
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
  /**
   * The filesystem, checked as the user every process runs as. Its
   * `privileged` view is the page's (mount, `fs.*`, watch) and the kernel's
   * own setup: those are not checked.
   */
  readonly vfs: PermissionedVfs;
  readonly workdir: string;
  /** The page's file requests (`fs.*`): unchecked, and relative to `workdir`. */
  readonly pageFiles: PageFiles;

  private readonly host: KernelHost;
  private readonly procs = new Map<number, Proc>();
  private readonly listening = new Map<number, Listener>();
  private readonly channels = new Map<number, Channel>();
  private readonly pageWatches = new Map<number, () => void>();
  /**
   * The processes an exited page process left running, by its pid: the page
   * can still end them with `killTree` of that pid, as it could before.
   */
  private readonly leftBehind = new Map<number, Set<number>>();
  private pendingWatchEvents = new Map<string, KernelEvent>();
  private watchFlush: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private nextListenerId = 1;
  private nextChannelId = 1;
  private nextWatchId = 1;
  private nextEphemeralPort = EPHEMERAL_PORT_START;
  /**
   * The port a connection's client end is labelled with. It is only a label
   * (nothing listens there), so it has its own counter and never uses up the
   * ports listen(0) picks from.
   */
  private nextConnectionPort = EPHEMERAL_PORT_START;
  private disposed = false;
  private readonly handlers: Record<string, Handler>;
  private readonly prepared: PreparedModules;

  constructor(vfs: PermissionedVfs, host: KernelHost, workdirName: string) {
    this.vfs = vfs;
    this.host = host;
    this.workdir = `${HOME_DIR}/projects/${workdirName}`;
    this.pageFiles = createPageFiles(vfs.privileged, (path) => this.resolveWorkdirPath(path));
    this.prepared = new PreparedModules(
      vfs.privileged,
      host.preparedStore ?? null,
      prepareInWorker((name) => host.createWorker(name)),
    );
    const setup = vfs.privileged;
    setup.mkdir(this.workdir, true, 0o755);
    setup.mkdir(TMP_DIR, true, 0o777);
    // As on Linux: anyone may make files there (the sticky bit changes
    // nothing for a user who owns every file, but stat reports it).
    setup.chmod(TMP_DIR, 0o1777, true);
    setup.mkdir("/dev", true, 0o755);
    // Each device is a link to itself in the tree, so the tree never holds a
    // file there: any spelling or link that reaches one fails with ELOOP
    // instead, and the kernel answers it (processBackend.ts routes it here).
    // Each is root's too, as on Linux, and the only link root owns: a path
    // that names the entry itself, its last link not followed (lstat,
    // readlink), is known for the device by that (`isDeviceEntry`).
    for (const name of DEVICE_NAMES) {
      try {
        setup.symlink(`/dev/${name}`, `/dev/${name}`);
      } catch {
        // Already there.
      }
      setup.giveToRoot(`/dev/${name}`);
    }
    // /dev is root's, 0755, as on Linux: the user makes, renames and removes
    // nothing there and changes neither its mode nor its times (its devices
    // are the kernel's and open as they did). Nor can /dev itself be removed
    // or renamed, by whatever path: the filesystems keep the entry of a node
    // root owns.
    setup.chmod("/dev", 0o755, true);
    setup.giveToRoot("/dev");
    installBuiltinCommands(setup);
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

  /** Writes a tree into the filesystem, whatever the modes in it (the page's request). */
  mount(entries: MountEntry[]): void {
    const fs = this.vfs.privileged;
    const made = new Set<string>();
    const ensureDirectory = (path: string) => {
      if (!made.has(path)) {
        fs.mkdir(path, true, 0o755);
        made.add(path);
      }
    };
    for (const entry of entries) {
      if ("directory" in entry) {
        ensureDirectory(entry.path);
      } else {
        ensureDirectory(entry.path.slice(0, entry.path.lastIndexOf("/")) || "/");
        fs.writeFile(entry.path, entry.data, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
      }
    }
  }

  /** Starts a process for the page, with a terminal as its stdio. Returns its pid. */
  spawnFromPage(command: string, args: string[], options: PageSpawnOptions): number {
    const env = this.defaultEnvironment();
    for (const [name, value] of Object.entries(options.env ?? {})) {
      env[name] = String(value);
    }
    // A directory the page chose is one its process changes into, so the
    // user must be able to enter it. With none the process starts where the
    // project is, unchecked like the page's other requests: the editor still
    // runs a command and opens a terminal after a learner's `chmod 000 .`,
    // and the learner undoes it there.
    const chosen = options.cwd ? this.resolveWorkdirPath(options.cwd) : null;
    const cwd = chosen ?? this.workdir;
    env.PWD = cwd;
    const resolved = resolveExec(this.vfs, command, args, env, cwd, chosen !== null);

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
    // The page's process leads the terminal's group; its foreground jobs join it.
    terminal.foregroundGroup = id;
    const fds = new Map<number, Description>();
    const description: Description = { kind: "tty", refs: 3, terminal, output: true };
    fds.set(0, description);
    fds.set(1, description);
    fds.set(2, description);

    this.startProcess({
      id,
      ppid: 0,
      pgid: id,
      lineage: [],
      parent: null,
      reportTo: null,
      fds,
      terminal,
      pageOwned: true,
      resolved,
      env,
      cwd,
      umask: DEFAULT_UMASK,
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
    const changed = terminal.cols !== size.cols || terminal.rows !== size.rows;
    terminal.cols = size.cols;
    terminal.rows = size.rows;
    // Everything that has the terminal as stdin, stdout or stderr sees its size.
    for (const proc of this.procs.values()) {
      if (
        [0, 1, 2].some((fd) => {
          const description = proc.fds.get(fd);
          return description?.kind === "tty" && description.terminal === terminal;
        })
      ) {
        proc.worker.postMessage({ type: "resize", terminal: size });
      }
    }
    // A change of size signals the terminal's foreground group, as a tty does.
    if (changed) {
      for (const proc of Array.from(this.procs.values())) {
        if (!proc.owner && !proc.exited && this.inForeground(proc, terminal)) {
          this.deliver(proc, "SIGWINCH");
        }
      }
    }
  }

  /** Ends `pid` and every process it started. */
  killTree(pid: number): void {
    const proc = this.procs.get(pid);
    if (!proc) {
      const left = this.leftBehind.get(pid);
      this.leftBehind.delete(pid);
      for (const child of left ?? []) {
        this.killTree(child);
      }
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
    let watched = root;
    // The page watches whatever the modes.
    const fs = this.vfs.privileged;
    const stop = fs.watch(root, recursive, (event) => {
      const filename = relativeName(watched, event.path, root);
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
    // Events carry where the watch really is: `.`, `//` and links resolved.
    watched = fs.realpath(root);
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
        remotePort: this.connectionPort(),
      },
      [port1],
    );
    return Promise.resolve(channel);
  }

  /** Ends every process and stops everything. */
  dispose(): void {
    this.disposed = true;
    this.prepared.dispose();
    for (const proc of Array.from(this.procs.values())) {
      this.stopWorker(proc);
    }
    this.procs.clear();
    for (const stop of this.pageWatches.values()) {
      stop();
    }
    this.pageWatches.clear();
    for (const listener of this.listening.values()) {
      if (listener.announce !== null) {
        clearTimeout(listener.announce);
      }
    }
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
    lineage: number[];
    parent: Proc | null;
    reportTo: Proc | null;
    fds: Map<number, Description>;
    terminal: Terminal | null;
    pageOwned: boolean;
    resolved: { program: ProcessInit["program"]; argv: string[]; execArgv: string[] };
    env: Record<string, string>;
    cwd: string;
    /** The mask the process starts with. */
    umask: number;
    ipc: MessagePort | null;
  }): Proc {
    const worker = this.host.createWorker(`webnode ${spec.id} ${spec.resolved.argv.join(" ")}`);
    const proc: Proc = {
      id: spec.id,
      pid: spec.id,
      ppid: spec.ppid,
      pgid: spec.pgid,
      lineage: spec.lineage,
      foregroundJob: null,
      owner: null,
      reportTo: spec.reportTo,
      threadId: 0,
      worker,
      argv: spec.resolved.argv,
      fds: spec.fds,
      umask: createUmaskCell(spec.umask),
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
      pendingWrites: new Set(),
      deliveries: new Map(),
      typed: new Map(),
      broken: 0,
      listeners: new Map(),
      channels: new Set(),
      handoffs: new Map(),
      exitWaiters: [],
      endWaiters: [],
      exited: false,
    };
    this.procs.set(proc.id, proc);
    spec.parent?.children.add(proc.id);
    const stdin = spec.fds.get(0);
    // Only the terminal's foreground reads it: a job started in a group of
    // its own (`cmd &`) keeps the shell's terminal as its stdin but never
    // takes it. One with another stdin joins when it reads (`joinReaders`).
    if (stdin?.kind === "tty" && this.inForeground(proc, stdin.terminal)) {
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
        umask: proc.umask,
        syncBuffer: proc.syncBuffer,
        sharedFs: this.admission(proc),
        ttyFds: terminalFds,
        inheritedFds: descriptorsAbove2(spec.fds),
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
      const stderr = proc.fds.get(2);
      // The kernel writes this for the process, which made no write of its
      // own: to a pipe nobody reads it goes nowhere, without the SIGPIPE
      // that would end the process before its exit code is set.
      if (stderr && !(stderr.kind === "pipe-write" && !stderr.pipe.hasReaders)) {
        try {
          // Written for the dying process, so it is not withdrawn when the process ends.
          settleQuietly(
            this.writeTo(
              proc,
              stderr,
              new TextEncoder().encode(`${event.message ?? "worker error"}\n`),
              "queue",
            ),
          );
        } catch {
          // Nowhere to report it.
        }
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
        this.publishBroken(proc);
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
          proc.handoffs.set(token, { port: ports[0], data, carried: ports.slice(1) });
          return;
        }
        try {
          settleQuietly(this.dispatch(proc, message.op, message.args));
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
      // The worker waits, and cannot take what its pumps send until it is answered.
      this.holdDeliveries(proc);
      result.then((value) => answer(true, value), fail).finally(() => this.resumeDeliveries(proc));
    } else {
      answer(true, result);
    }
  }

  /**
   * A worker waits in a blocking call, and can take nothing until it is
   * answered. Its pumps stop: each withdraws its wait to read, so the worker
   * is not a reader waiting for a terminal's input, and what arrives
   * meanwhile is for a reader that can take it (the child it waits for, or
   * its own blocking read). What its pumps had sent from pipes and it has
   * not received becomes its own (it gets it once it is answered), so it no
   * longer takes up room another reader or the call itself may need: a
   * `spawnSync` child reading the same pipe, or a blocking read of a pipe
   * the worker also streams.
   */
  private holdDeliveries(proc: Proc): void {
    if (proc.exited) {
      return;
    }
    // The pumps first: freeing a pipe's room lets its writers in, which
    // would wake a pump still waiting to read.
    for (const pump of Array.from(proc.pumps.values())) {
      pump.pause();
    }
    for (const delivery of proc.deliveries.values()) {
      delivery.hold();
    }
  }

  /**
   * The worker was answered: its pumps go on. One whose pipe sent bytes that
   * became the worker's own (`holdDeliveries`) waits until the worker has
   * received them (`delivered`), which keeps what it is owed bounded.
   */
  private resumeDeliveries(proc: Proc): void {
    for (const pump of Array.from(proc.pumps.values())) {
      pump.resume();
    }
  }

  /** `proc` received `bytes` of what its pump on `fd` sent (`fd.ack`). */
  private delivered(proc: Proc, fd: number, bytes: number): void {
    const typed = proc.typed.get(fd);
    if (typed) {
      typed.received(bytes);
      if (typed.empty) {
        proc.typed.delete(fd);
      }
      return;
    }
    const delivery = proc.deliveries.get(fd);
    if (!delivery) {
      return;
    }
    delivery.received(bytes);
    if (delivery.empty) {
      proc.deliveries.delete(fd);
      // The pump sends its next delivery once the last one arrived.
      proc.pumps.get(fd)?.next();
    }
  }

  /**
   * Puts what `proc`'s pump on `fd` sent and `proc` never received back into
   * the pipe or the terminal, for the next reader, as read(2) would have
   * left it there.
   */
  private undeliver(proc: Proc, fd: number): void {
    const delivery = proc.deliveries.get(fd);
    if (delivery) {
      proc.deliveries.delete(fd);
      delivery.putBack();
    }
    const typed = proc.typed.get(fd);
    if (typed) {
      proc.typed.delete(fd);
      typed.putBack();
    }
  }

  /**
   * Tells each worker that writes to `pipe`, which has just lost its last
   * reader, through its sync buffer: it may have handed over writes that
   * will fail, and its next write asks the kernel (sysClient.ts).
   */
  private pipeBroken(pipe: Pipe): void {
    for (const proc of this.procs.values()) {
      for (const description of proc.fds.values()) {
        if (description.kind === "pipe-write" && description.pipe === pipe) {
          this.markBroken(proc);
          break;
        }
      }
    }
  }

  private markBroken(proc: Proc): void {
    proc.broken += 1;
    this.publishBroken(proc);
  }

  private publishBroken(proc: Proc): void {
    Atomics.store(
      new Int32Array(proc.syncBuffer, 0, SYNC_HEADER_BYTES / 4),
      SYNC_BROKEN,
      proc.broken,
    );
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
    this.deliver(proc, signal);
  }

  /**
   * kill(2) from `caller`: a positive pid is that process, 0 the caller's
   * process group, -1 every process but the caller, and any other negative
   * pid the group -pid. Throws `ESRCH` when nothing matched.
   */
  private kill(caller: Proc, pid: number, signal: string): void {
    if (pid > 0) {
      this.signal(pid, signal);
      return;
    }
    const self = caller.owner ?? caller;
    const group = pid === 0 ? self.pgid : -pid;
    const targets = [...this.procs.values()].filter(
      (proc) => !proc.owner && !proc.exited && (pid === -1 ? proc !== self : proc.pgid === group),
    );
    if (targets.length === 0) {
      throw createSystemError("ESRCH", "kill");
    }
    // The caller last: the signal may end it.
    targets.sort((a, b) => Number(a === self) - Number(b === self));
    for (const proc of targets) {
      this.deliver(proc, signal);
    }
  }

  /**
   * Delivers `signal` to `proc`: to its handler, or as the signal's default
   * action. `fromTerminal`: the terminal sends it, to its whole foreground
   * group; the handler is told, so that a process which passes signals on to
   * its children (a shell) knows they have this one already.
   */
  private deliver(proc: Proc, signal: string, fromTerminal = false): void {
    if (signal === "0" || proc.exited) {
      return;
    }
    if (signal !== "SIGKILL" && signal !== "SIGSTOP" && proc.handledSignals.has(signal)) {
      proc.worker.postMessage(
        fromTerminal ? { type: "signal", signal, fromTerminal } : { type: "signal", signal },
      );
      return;
    }
    if (!endsByDefault(signal)) {
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
      this.deliver(proc, "SIGINT", true);
    }
  }

  /**
   * Whether `process` is in `terminal`'s foreground: a member of the
   * terminal's process group none of whose ancestors has ended. What an
   * ended process left running stays in its group, so the terminal's Ctrl+C
   * still reaches it, but a shell with job control would have taken the
   * terminal back from it: it reads the terminal like a background process
   * (its read waits) and has no say over the terminal's mode.
   */
  private inForeground(process: Proc, terminal: Terminal): boolean {
    return (
      process.pgid === terminal.foregroundGroup &&
      process.lineage.every((pid) => this.procs.has(pid))
    );
  }

  /**
   * `proc` is about to read `terminal`. A process in the terminal's
   * foreground that is not one of its readers yet becomes one: its stdin is
   * something else and it opened /dev/tty, as a program that prompts inside
   * a pipeline does. On Linux every member of the foreground group may read
   * the terminal, whatever its stdin is.
   */
  private joinReaders(proc: Proc, terminal: Terminal): void {
    const process = proc.owner ?? proc;
    if (this.inForeground(process, terminal)) {
      terminal.attach(process.pid);
    }
  }

  /**
   * `shell` makes its group the terminal's foreground again once a job it
   * ran there has ended, as a job-control shell does with tcsetpgrp. On
   * Linux each job has a group of its own, numbered by its first process,
   * and the processes a job leaves running (an orphan whose parent was
   * killed) stay in it, out of the foreground. Here the shell's foreground
   * jobs run in its own group, so those processes move now, together, to the
   * group their job would have had: the terminal's Ctrl+C and input no
   * longer reach them, and `kill -- -<job>` reaches them all, whichever
   * program of a pipeline started them. Only the shell's own descendants
   * move, never a shell it runs in; and nothing does for a shell outside the
   * terminal's foreground group (on Linux tcsetpgrp would stop it).
   */
  private reclaimTerminal(shell: Proc, terminal: Terminal): void {
    const job = shell.foregroundJob;
    shell.foregroundJob = null;
    if (shell.pgid !== terminal.foregroundGroup) {
      return;
    }
    // The newest first: each puts back the terminal mode it found.
    for (const proc of Array.from(this.procs.values()).reverse()) {
      if (proc.owner || proc.exited || proc === shell || proc.pgid !== shell.pgid) {
        continue;
      }
      const at = proc.lineage.indexOf(shell.pid);
      if (at < 0) {
        continue;
      }
      // The job's group; for a process that joined the shell's group by
      // itself, the shell's child it descends from (itself, for a child).
      proc.pgid = job ?? proc.lineage[at + 1] ?? proc.pid;
      for (const thread of proc.threads) {
        thread.pgid = proc.pgid;
      }
      proc.terminal?.detach(proc.pid);
    }
  }

  /** A write to a pipe nobody reads: SIGPIPE to the writer, whose default action ends it. */
  private brokenPipe(proc: Proc): void {
    const process = proc.owner ?? proc;
    if (process.exited) {
      return;
    }
    // Its writes handed over without waiting may fail the same way: the next one asks.
    this.markBroken(proc);
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
    for (const pump of proc.pumps.values()) {
      pump.stop();
    }
    proc.pumps.clear();
    for (const read of Array.from(proc.pendingReads)) {
      read.giveUp(processGone());
    }
    // A write(2) its process dies in leaves the bytes already in the pipe, and no more.
    for (const withdraw of Array.from(proc.pendingWrites)) {
      withdraw();
    }
    proc.pendingWrites.clear();
    // Before its fds close, so another reader of the pipe gets them, and
    // before its terminal changes mode, so keys go back as they were typed.
    for (const fd of [...proc.deliveries.keys(), ...proc.typed.keys()]) {
      this.undeliver(proc, fd);
    }
    for (const channelId of Array.from(proc.channels)) {
      this.dropChannel(channelId, proc.id);
    }
    proc.channels.clear();
    for (const [listenerId, port] of Array.from(proc.listeners)) {
      this.closeListener(proc, listenerId, port);
    }
    for (const handoff of proc.handoffs.values()) {
      handoff.port?.close();
      for (const port of handoff.carried) {
        port.close();
      }
    }
    proc.handoffs.clear();
  }

  /**
   * Runs `create`, a call that may make a file or a directory for `proc`, as
   * a caller with the process's file mode creation mask.
   */
  private creating<T>(proc: Proc, create: () => T): T {
    return this.vfs.withUmask(readUmask(proc.umask), create);
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
      // A thread: its process keeps the file descriptors. As in Node, the
      // threads it started end with it, and the thread that started it
      // (reportTo) hears its exit.
      proc.owner.threads.delete(proc);
      for (const thread of Array.from(proc.owner.threads)) {
        if (thread.reportTo === proc) {
          this.finish(thread, { code: 1, signal: null });
        }
      }
      const starter = proc.reportTo;
      if (starter && !starter.exited) {
        starter.worker.postMessage({
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
    this.leaveForeground(proc, proc.pid);
    for (const fd of Array.from(proc.fds.keys())) {
      this.closeFd(proc, fd);
    }

    const orphans: Proc[] = [];
    for (const childId of proc.children) {
      const child = this.procs.get(childId);
      if (child) {
        orphans.push(child);
      }
    }
    proc.children.clear();
    this.adoptOrphans(proc.pid, proc.ppid, proc.pageOwned, orphans);
    for (const ended of proc.endWaiters.splice(0)) {
      ended();
    }
    this.reportExit(proc, proc.pid, status, proc.reportTo);
  }

  /**
   * Process `pid`, which `proc` was, ends (or goes on as a new process): what
   * it started leaves the terminal's foreground with it (see `inForeground`).
   * Reading on, it would keep every key from the shell that goes on after
   * it. A process it did not start, one its parent started beside it, keeps
   * the terminal. The newest goes first, and `proc` last, so each puts back
   * the terminal mode it found: however the process ends, and even once it
   * has closed the fd, the terminal is as it was before it started (as libuv
   * resets the mode at exit).
   */
  private leaveForeground(proc: Proc, pid: number): void {
    const started = Array.from(this.procs.values()).filter(
      (other) => !other.owner && other.lineage.includes(pid),
    );
    for (const other of started.reverse()) {
      other.terminal?.detach(other.pid);
    }
    proc.terminal?.detach(pid);
  }

  /**
   * Process `pid`, whose parent was `ppid` (and which the page started when
   * `pageOwned`), has ended, and `orphans` are what it leaves running: they
   * go to its parent, so `killTree` still reaches them. A page process has
   * none: its pid keeps them for the page instead, as does the pid of the
   * page process whose leftovers the ended one was among. Nobody hears an
   * orphan's exit any more.
   */
  private adoptOrphans(pid: number, ppid: number, pageOwned: boolean, orphans: Proc[]): void {
    const parent = this.procs.get(ppid);
    const keeper = parent
      ? null
      : pageOwned
        ? new Set<number>()
        : (this.leftBehind.get(ppid) ?? null);
    for (const orphan of orphans) {
      orphan.reportTo = null;
      if (parent) {
        orphan.ppid = parent.pid;
        parent.children.add(orphan.id);
      } else if (keeper) {
        orphan.ppid = pageOwned ? pid : ppid;
        keeper.add(orphan.id);
      }
    }
    if (pageOwned && keeper && keeper.size > 0 && !this.disposed) {
      this.leftBehind.set(pid, keeper);
    }
    const siblings = this.leftBehind.get(ppid);
    if (siblings?.delete(pid) && siblings.size === 0) {
      this.leftBehind.delete(ppid);
    }
    parent?.children.delete(pid);
  }

  /**
   * Tells whoever waits for process `pid`, which `proc` was, that it ended
   * with `status`: the process that started it (`reportTo`), its other
   * waiters, and the page for a page process.
   */
  private reportExit(proc: Proc, pid: number, status: ExitStatus, reportTo: Proc | null): void {
    if (reportTo) {
      // After the answers its exit settled: a write to its stdin still
      // waiting for room fails (EPIPE) as its fds close, and the writer
      // hears that before the exit, as in Node.
      queueMicrotask(() => {
        if (!reportTo.exited) {
          reportTo.worker.postMessage({ type: "child-exit", pid, status });
        }
      });
    }
    for (const waiter of proc.exitWaiters.splice(0)) {
      waiter(status);
    }
    if (proc.pageOwned && !this.disposed) {
      this.host.emit({ event: "exit", pid, code: exitStatusNumber(status) });
    }
  }

  /**
   * fork(2) and the parent's exit at once (`ProcessBackend.forkAndExit`):
   * `proc` is reported ended with `status`, as `finish` reports it, and its
   * worker goes on, with everything it holds, as a new process: the orphan
   * the forked child would be once its parent had ended. Returns the new
   * process's pid and ppid.
   */
  private forkAndExit(proc: Proc, status: ExitStatus): { pid: number; ppid: number } {
    if (proc.owner) {
      throw createSystemError("EINVAL", "fork");
    }
    const oldPid = proc.pid;
    const oldPpid = proc.ppid;
    const pageOwned = proc.pageOwned;
    const reportTo = proc.reportTo;
    const newPid = this.nextId++;
    // The old process and what it started leave the terminal's foreground as
    // at its end (`finish`): the new process is not in it either, its
    // lineage naming a process that has ended.
    this.leaveForeground(proc, oldPid);

    this.procs.delete(oldPid);
    proc.id = newPid;
    proc.pid = newPid;
    proc.lineage = [...proc.lineage, oldPid];
    this.procs.set(newPid, proc);
    // The new process is the orphan the old one leaves (`finish`).
    this.adoptOrphans(oldPid, oldPpid, pageOwned, [proc]);
    for (const thread of proc.threads) {
      thread.pid = newPid;
      thread.ppid = proc.ppid;
      thread.lineage = proc.lineage;
    }
    for (const childId of proc.children) {
      const child = this.procs.get(childId);
      if (child) {
        child.ppid = newPid;
      }
    }
    for (const channelId of proc.channels) {
      const channel = this.channels.get(channelId);
      if (channel) {
        channel.ends = channel.ends.map((end) => (end === oldPid ? newPid : end)) as [
          number,
          number,
        ];
      }
    }

    // The old process's exit, for whoever waits for it; nobody waits for the new one.
    this.reportExit(proc, oldPid, status, reportTo);
    proc.pageOwned = false;
    return { pid: newPid, ppid: proc.ppid };
  }

  // -------------------------------------------------------------------------
  // File descriptors
  // -------------------------------------------------------------------------

  /**
   * Gives `description` the lowest number `proc` has free, as POSIX says of
   * every call that makes a descriptor (open, pipe, dup): 0, 1 or 2 too, once
   * the process has closed it.
   */
  private allocateFd(proc: Proc, description: Description): number {
    let fd = 0;
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
    // The descriptors are the process's, shared by its threads: whichever of
    // them streams this one stops. Each drops what arrives for a closed fd:
    // what is still on its way goes back to the pipe or the terminal, for
    // any other reader.
    const process = proc.owner ?? proc;
    for (const worker of [process, ...process.threads]) {
      worker.pumps.get(fd)?.stop();
      worker.pumps.delete(fd);
      this.undeliver(worker, fd);
    }
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
      if (!description.pipe.hasReaders) {
        this.pipeBroken(description.pipe);
      }
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

  private writeToFd(
    proc: Proc,
    fd: number,
    data: Uint8Array,
    how: WriteMode,
  ): number | Promise<number> {
    return this.writeTo(proc, this.description(proc, fd, "write"), data, how);
  }

  /**
   * Writes `data`; only a pipe can make a write wait (see `WriteMode`). The
   * answer is the bytes written, once they are written.
   */
  private writeTo(
    proc: Proc,
    description: Description,
    data: Uint8Array,
    how: WriteMode,
  ): number | Promise<number> {
    switch (description.kind) {
      case "file":
        return description.file.write(data, null);
      case "pipe-write":
        return this.writeToPipe(proc, description.pipe, data, how);
      case "tty":
        description.terminal.write(data);
        return data.byteLength;
      case "null":
        return data.byteLength;
      default:
        throw createSystemError("EBADF", "write");
    }
  }

  /**
   * A write to a pipe, as write(2) on a blocking pipe: what fits goes in at
   * once and the rest as the reader makes room (`WriteMode` says who waits).
   * With no reader left, before or during the wait, the writer gets SIGPIPE
   * (which ends one that does not handle it) and EPIPE; a waiting "wait"
   * write that got some bytes in answers with that count instead, as write(2)
   * does, and the next write fails.
   */
  private writeToPipe(
    proc: Proc,
    pipe: Pipe,
    data: Uint8Array,
    how: WriteMode,
  ): number | Promise<number> {
    if (data.byteLength === 0) {
      // As Linux's pipe_write: a write of no bytes returns before it looks for a reader.
      return 0;
    }
    if (!pipe.hasReaders) {
      this.brokenPipe(proc);
      throw createSystemError("EPIPE", "write");
    }
    const taken = pipe.tryWrite(data);
    if (taken === data.byteLength) {
      return taken;
    }
    return new Promise((resolve, reject) => {
      let done = false;
      let gone: (() => void) | null = null;
      const withdraw = pipe.write(data.subarray(taken), (written, broken) => {
        done = true;
        if (gone) {
          proc.pendingWrites.delete(gone);
        }
        if (!broken) {
          resolve(data.byteLength);
          return;
        }
        if (how === "wait") {
          this.brokenPipe(proc);
        } else if (!proc.exited) {
          // Handed over, it was as good as in the pipe, and bytes a reader
          // leaves there go without a signal: only a write after that gets
          // SIGPIPE. (A writer of many small writes would get one each.)
          this.markBroken(proc);
        }
        if (how === "wait" && taken + written > 0) {
          resolve(taken + written);
        } else {
          reject(createSystemError("EPIPE", "write"));
        }
      });
      // A blocked write(2) ends with its process: the rest is withdrawn, and
      // the write settles so that what it holds (a device's reference) is let
      // go. A queued write was handed over (the process does not wait for
      // it) and still goes in.
      if (how === "wait" && !done) {
        gone = () => {
          withdraw();
          reject(processGone());
        };
        proc.pendingWrites.add(gone);
      }
    });
  }

  /** The stat of what a descriptor holds. */
  private statOf(description: Description): StatData {
    if (description.kind === "file") {
      return description.file.stat();
    }
    if (description.kind === "null") {
      // The device itself, as `deviceStat` reports it: root's crw-rw-rw-.
      return streamStat(S_IFCHR | 0o666, ROOT_ID);
    }
    // A terminal is the user's crw--w----, a pipe the user's prw-------.
    return streamStat(description.kind === "tty" ? S_IFCHR | 0o620 : S_IFIFO | 0o600);
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /** Opens `device` (a path `isDevicePath` accepts) as a new reference. */
  private openDevice(proc: Proc, device: string): Description {
    if (device === "/dev/null") {
      return { kind: "null", refs: 1 };
    }
    if (device === "/dev/tty") {
      const terminal = proc.terminal ?? this.anyTerminal(proc.fds);
      if (!terminal) {
        throw createSystemError("ENXIO", "open", device);
      }
      return { kind: "tty", refs: 1, terminal, output: true };
    }
    const fd = deviceFd(device);
    const description = fd === null ? undefined : proc.fds.get(fd);
    if (!description) {
      throw createSystemError(fd === null ? "EISDIR" : "ENOENT", "open", device);
    }
    description.refs += 1;
    return description;
  }

  /** Runs `use` on `device` opened for it, and closes it again once `use` is done. */
  private useDevice<T>(
    proc: Proc,
    device: string,
    use: (description: Description) => T | Promise<T>,
  ): T | Promise<T> {
    const description = this.openDevice(proc, device);
    let result: T | Promise<T>;
    try {
      result = use(description);
    } catch (error) {
      this.release(description);
      throw error;
    }
    if (result instanceof Promise) {
      return result.finally(() => this.release(description));
    }
    this.release(description);
    return result;
  }

  /**
   * Writes all of `data` to `device`, as writeFile does with write(2) in a
   * loop: a pipe whose reader goes away part of the way through makes the
   * write that comes next fail, so the whole call fails with EPIPE.
   */
  private writeAllToDevice(
    proc: Proc,
    device: string,
    data: Uint8Array,
  ): undefined | Promise<undefined> {
    const whole = (written: number): undefined => {
      if (written < data.byteLength) {
        throw createSystemError("EPIPE", "write");
      }
      return undefined;
    };
    const written = this.useDevice(proc, device, (description) =>
      this.writeTo(proc, description, data, "wait"),
    );
    return written instanceof Promise ? written.then(whole) : whole(written);
  }

  private deviceExists(proc: Proc, device: string): boolean {
    const fd = deviceFd(device);
    return fd === null || proc.fds.has(fd);
  }

  private deviceStat(proc: Proc, device: string, syscall: string): StatData {
    if (device === "/dev/fd") {
      // A directory, root's, as on macOS (on Linux a link to /proc/self/fd).
      return streamStat(S_IFDIR | 0o555, ROOT_ID);
    }
    const fd = deviceFd(device);
    if (fd === null) {
      // /dev/null and /dev/tty are root's, as on Linux.
      return streamStat(S_IFCHR | 0o666, ROOT_ID);
    }
    const description = proc.fds.get(fd);
    if (!description) {
      throw createSystemError("ENOENT", syscall, device);
    }
    return this.statOf(description);
  }

  /** Everything `description` gives until its end, as reading a whole file does. */
  private readAll(proc: Proc, description: Description): Uint8Array | Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    if (description.kind === "file") {
      // /dev/stdin on a file opens that file afresh: it reads from the start.
      for (let position = 0; ;) {
        const chunk = description.file.read(PIPE_CAPACITY, position);
        if (chunk.byteLength === 0) {
          return concat(chunks);
        }
        chunks.push(chunk);
        position += chunk.byteLength;
      }
    }
    if (description.kind === "pipe-write") {
      throw createSystemError("EBADF", "read");
    }
    const source = this.source(description);
    if (!source) {
      return new Uint8Array(0);
    }
    const next = (): Uint8Array | Promise<Uint8Array> => {
      for (;;) {
        const chunk = this.readSource(proc, source, PIPE_CAPACITY);
        if (chunk instanceof Promise) {
          return chunk.then((bytes) => {
            if (bytes.byteLength === 0) {
              return concat(chunks);
            }
            chunks.push(bytes);
            return next();
          });
        }
        if (chunk.byteLength === 0) {
          return concat(chunks);
        }
        chunks.push(chunk);
      }
    };
    return next();
  }

  /**
   * Where `path` leads through the kernel's devices (`walkDevicePath`),
   * the last part's link followed when `follow` is; null when no device is
   * on the way. Only asked after the tree found a loop of links, which is
   * what a device's own link gives, or an entry that is one.
   */
  private walk(path: string, follow: boolean): DeviceWalk | null {
    return walkDevicePath(this.vfs, path, follow);
  }

  /** The device `path` leads to, following links in the tree; null when it leads anywhere else. */
  private deviceBehind(path: string, follow = true): string | null {
    const end = this.walk(path, follow);
    return end !== null && "device" in end ? end.device : null;
  }

  /**
   * `onDevice` with the device when `path` is one of the kernel's devices,
   * however it is spelled or linked to, else `onTree` with the path. A path
   * that goes through a device into the tree (`/dev/fd/..`) is `onTree` with
   * the place it leads to, and its errors name `path` as it was given; one
   * that goes through a device that is no directory is ENOTDIR. `follow`:
   * whether the call follows a link in the last part.
   */
  private onPath<T>(
    path: string,
    onDevice: (device: string) => T,
    onTree: (path: string) => T,
    follow = true,
  ): T {
    const device = deviceOf(path);
    if (device !== null) {
      return onDevice(device);
    }
    try {
      return onTree(path);
    } catch (error) {
      const record = toSystemErrorRecord(error);
      const end = record?.code === "ELOOP" ? this.walk(path, follow) : null;
      if (record === null || end === null) {
        throw error;
      }
      if ("device" in end) {
        return onDevice(end.device);
      }
      if ("error" in end) {
        throw createSystemError(end.error, record.syscall, record.path, record.dest);
      }
      try {
        return onTree(end.tree);
      } catch (again) {
        const failure = toSystemErrorRecord(again);
        if (failure === null) {
          throw again;
        }
        const named = (given: string | undefined) => (given === end.tree ? path : given);
        throw createSystemError(
          failure.code,
          failure.syscall,
          named(failure.path),
          named(failure.dest),
        );
      }
    }
  }

  /** `onPath` for a call on two paths, neither link followed: `onDevice` when either is a device. */
  private onPaths<T>(first: string, second: string, onDevice: () => T, onTree: () => T): T {
    if (deviceOf(first) !== null || deviceOf(second) !== null) {
      return onDevice();
    }
    try {
      return onTree();
    } catch (error) {
      const record = toSystemErrorRecord(error);
      if (record?.code !== "ELOOP") {
        throw error;
      }
      const ends = [this.walk(first, false), this.walk(second, false)];
      if (ends.some((end) => end !== null && "device" in end)) {
        return onDevice();
      }
      const walkError = ends.find((end) => end !== null && "error" in end);
      if (walkError !== undefined && walkError !== null && "error" in walkError) {
        throw createSystemError(walkError.error, record.syscall, record.path, record.dest);
      }
      throw error;
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
      // `inheritCwd`: the child stays in its parent's directory, as after a
      // fork (a shell's command, a spawn with no `cwd` option), so nothing
      // checks it; else it changes into `cwd`, as libuv's child does.
      resolved = resolveExec(
        this.vfs,
        request.command,
        request.args,
        request.env,
        request.cwd,
        request.inheritCwd !== true,
      );
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

    // As libuv sets up a child: a descriptor given as 'ignore', or one
    // whose source is closed in the parent, reads and writes /dev/null when
    // it is 0, 1 or 2, and is left closed above them (the child's EBADF).
    const closedOrNull = (fd: number) => {
      if (fd <= 2) {
        fds.set(fd, { kind: "null", refs: 1 });
      }
    };
    stdio.forEach((spec, fd) => {
      parentFds[fd] = null;
      if (spec === "ignore") {
        closedOrNull(fd);
        return;
      }
      if (spec === "ipc") {
        return;
      }
      if (spec === "inherit" || typeof spec === "number") {
        const source = process.fds.get(spec === "inherit" ? fd : spec);
        if (!source) {
          closedOrNull(fd);
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
          // The kernel writes the input as the child reads it, the way the
          // parent's event loop does in Node; the end follows the last byte.
          // A child that ends before taking it all is an EPIPE, as in Node.
          pipe.write(capture.input, (_written, broken) => {
            capture.inputBroken = broken;
          });
        }
        this.release(parentEnd);
      } else if (fd === 1 || fd === 2) {
        this.drain(pipe, fd === 1 ? capture.stdout : capture.stderr, capture);
      } else {
        this.release(parentEnd);
      }
    });

    const id = this.nextId++;
    const proc = this.startProcess({
      id,
      ppid: process.pid,
      pgid: request.newGroup ? id : process.pgid,
      lineage: [...process.lineage, process.pid],
      parent: process,
      // spawnSync collects the exit itself; a spawn reports it to the worker that asked.
      reportTo: capture ? null : parent,
      fds,
      terminal: process.terminal,
      pageOwned: false,
      resolved,
      env: request.env,
      cwd: request.cwd,
      // A copy of the parent's as it is now, as fork(2) gives a child.
      umask: request.umask ?? readUmask(process.umask),
      ipc: handoff?.port ?? null,
    });
    if (!request.newGroup) {
      process.foregroundJob ??= id;
    }
    return { proc, stdio: parentFds };
  }

  /**
   * Collects everything written to `pipe` into `chunks` until it ends (every
   * write end closed, the child's and any a descendant still holds), reading
   * at most SPAWN_SYNC_READ_BYTES at a time as Node's spawnSync does. The read
   * that takes the total over `capture.maxBuffer` is kept whole, as in Node;
   * then the read end is dropped and the overflow reported.
   */
  private drain(pipe: Pipe, chunks: Uint8Array[], capture: Capture): void {
    const limit = capture.maxBuffer ?? Infinity;
    let total = 0;
    let waiting: (() => void) | null = null;
    const drop = () => {
      if (!capture.readEnds.delete(drop)) {
        return;
      }
      waiting?.();
      waiting = null;
      pipe.removeReader();
      if (!pipe.hasReaders) {
        // Every writer's next write asks, and fails, as after a reader's close.
        this.pipeBroken(pipe);
      }
      capture.onReadEnd?.();
    };
    capture.readEnds.add(drop);
    const pump = () => {
      waiting = null;
      for (;;) {
        const chunk = pipe.take(SPAWN_SYNC_READ_BYTES);
        if (chunk === null) {
          drop();
          return;
        }
        if (chunk === undefined) {
          waiting = pipe.whenReadable(0, pump);
          return;
        }
        total += chunk.byteLength;
        chunks.push(chunk);
        if (total > limit) {
          drop();
          capture.onOverflow?.();
          return;
        }
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
      readEnds: new Set(),
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

    // The child's pid as it started: a child that goes on as a new process
    // (`forkAndExit`) is the one that was started all the same.
    const childPid = child.pid;
    return new Promise((resolve) => {
      let timedOut = false;
      let overflowed = false;
      let exitStatus: ExitStatus | null = null;
      let settled = false;
      const dropReadEnds = () => {
        for (const drop of Array.from(capture.readEnds)) {
          drop();
        }
      };
      // A caller that ends while it waits closes its read ends with it: what
      // the child or a descendant still writes there is a broken pipe.
      const caller = parent.owner ?? parent;
      const callerEnded = () => dropReadEnds();
      // As Node's spawnSync (SyncProcessRunner::Kill): a timeout or an
      // overflow sends the kill signal to the child alone, if it still runs,
      // and lets go of the pipes, without waiting for what a descendant that
      // holds them would still write. The call then waits for the child to
      // end: a child that handles the signal (a shell's trap) or ignores it
      // ends when it will, and what it started runs on.
      const stop = () => {
        if (exitStatus === null) {
          try {
            this.signal(childPid, request.killSignal ?? "SIGTERM");
          } catch {
            // Gone already (ESRCH): nothing to signal, as in Node.
          }
        }
        dropReadEnds();
      };
      const timer =
        request.timeoutMs && request.timeoutMs > 0
          ? setTimeout(() => {
              if (!overflowed) {
                timedOut = true;
                stop();
              }
            }, request.timeoutMs)
          : null;
      capture.onOverflow = () => {
        if (!overflowed && !timedOut) {
          overflowed = true;
          stop();
        }
      };
      // The call returns once the child has exited and the pipes it captured
      // have ended, as Node's does: a descendant that still holds one keeps
      // it waiting, up to the timeout.
      const settle = () => {
        if (settled || exitStatus === null || capture.readEnds.size > 0) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        const waiting = caller.endWaiters.indexOf(callerEnded);
        if (waiting >= 0) {
          caller.endWaiters.splice(waiting, 1);
        }
        // The status the child really ended with, as Node reports it: the
        // kill signal's, or whatever the child made of it.
        const result: SpawnSyncResult = {
          pid: childPid,
          status: exitStatus,
          stdout: concat(capture.stdout),
          stderr: concat(capture.stderr),
        };
        if (timedOut) {
          result.error = "ETIMEDOUT";
        } else if (overflowed) {
          result.error = "ENOBUFS";
        } else if (capture.inputBroken) {
          result.error = toSystemErrorRecord(createSystemError("EPIPE", "write")) ?? undefined;
        }
        resolve(result);
      };
      capture.onReadEnd = () => queueMicrotask(settle);
      caller.endWaiters.push(callerEnded);
      child.exitWaiters.push((status) => {
        exitStatus = status;
        // The pipes drain in the same turn the child's descriptors close.
        queueMicrotask(settle);
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
      lineage: process.lineage,
      foregroundJob: null,
      owner: process,
      // The thread or main thread that started it: it hears the thread's exit.
      reportTo: parent,
      threadId: id,
      worker,
      argv: request.argv,
      fds: process.fds,
      umask: process.umask,
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
      pendingWrites: new Set(),
      deliveries: new Map(),
      typed: new Map(),
      broken: 0,
      listeners: new Map(),
      channels: new Set(),
      handoffs: new Map(),
      exitWaiters: [],
      endWaiters: [],
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
        umask: thread.umask,
        syncBuffer: thread.syncBuffer,
        sharedFs: this.admission(thread),
        ttyFds: [0, 1, 2].filter((fd) => process.fds.get(fd)?.kind === "tty"),
        inheritedFds: descriptorsAbove2(process.fds),
        terminal: terminal ? { cols: terminal.cols, rows: terminal.rows } : DEFAULT_TERMINAL,
        ipc: null,
      },
      // The ports in the thread's workerData go on to the thread with it.
      [handoff.port, ...handoff.carried],
    );
    return id;
  }

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------

  private listen(proc: Proc, port: number): { port: number; listenerId: number } {
    let chosen = port;
    if (chosen === 0) {
      chosen = this.freeEphemeralPort();
    } else if (this.listening.has(chosen)) {
      const error = createSystemError("EADDRINUSE", "listen");
      error.port = chosen;
      error.address = "0.0.0.0";
      throw error;
    }
    const listenerId = this.nextListenerId++;
    const listener: Listener = { proc, listenerId, announce: null };
    // Connections are accepted from now; the page hears of it once the listener has stayed.
    listener.announce = setTimeout(() => {
      listener.announce = null;
      if (!this.disposed) {
        this.host.emit({ event: "port", port: chosen, type: "open" });
      }
    }, PORT_ANNOUNCE_DELAY_MS);
    this.listening.set(chosen, listener);
    proc.listeners.set(listenerId, chosen);
    return { port: chosen, listenerId };
  }

  /** The next ephemeral port nothing listens on, wrapping round the range; EADDRINUSE when all are taken. */
  private freeEphemeralPort(): number {
    for (let tried = 0; tried <= EPHEMERAL_PORT_END - EPHEMERAL_PORT_START; tried += 1) {
      const port = this.nextEphemeralPort;
      this.nextEphemeralPort = port === EPHEMERAL_PORT_END ? EPHEMERAL_PORT_START : port + 1;
      if (!this.listening.has(port)) {
        return port;
      }
    }
    const error = createSystemError("EADDRINUSE", "listen");
    error.port = 0;
    error.address = "0.0.0.0";
    throw error;
  }

  /** The label for a new connection's client end, wrapping round the ephemeral range. */
  private connectionPort(): number {
    const port = this.nextConnectionPort;
    this.nextConnectionPort = port === EPHEMERAL_PORT_END ? EPHEMERAL_PORT_START : port + 1;
    return port;
  }

  private closeListener(proc: Proc, listenerId: number, port: number): void {
    proc.listeners.delete(listenerId);
    const listener = this.listening.get(port);
    if (listener?.listenerId === listenerId) {
      this.listening.delete(port);
      if (listener.announce !== null) {
        // Gone before the page was told it was there: nothing to take back.
        clearTimeout(listener.announce);
      } else if (!this.disposed) {
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
    const localPort = this.connectionPort();
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
      // Paths. The kernel's devices (/dev/null, /dev/stdin … /dev/fd/N) are
      // answered here under any spelling; nothing creates a file at one.
      "fs.stat": (proc: Proc, path: string, follow: boolean) =>
        this.onPath(
          path,
          (device) => this.deviceStat(proc, device, follow ? "stat" : "lstat"),
          (at) => {
            const stat = vfs.stat(at, follow);
            const device = follow || !isDeviceEntry(stat) ? null : this.deviceBehind(at, false);
            return device === null ? stat : this.deviceStat(proc, device, "lstat");
          },
          follow,
        ),
      "fs.exists": (proc: Proc, path: string) => {
        const device = deviceOf(path);
        if (device !== null) {
          return this.deviceExists(proc, device);
        }
        if (vfs.exists(path)) {
          return true;
        }
        // Missing, or a link that may lead to a device.
        try {
          vfs.stat(path, false);
        } catch (error) {
          if (!isLinkLoop(error)) {
            return false;
          }
        }
        const end = this.walk(path, true);
        if (end === null || "error" in end) {
          return false;
        }
        return "device" in end ? this.deviceExists(proc, end.device) : vfs.exists(end.tree);
      },
      "fs.readdir": (proc: Proc, path: string) =>
        this.onPath(
          path,
          (device) => {
            if (device !== "/dev/fd") {
              throw createSystemError("ENOTDIR", "scandir", path);
            }
            return [...proc.fds.keys()]
              .sort((a, b) => a - b)
              .map((fd) => ({ name: String(fd), type: "symlink" as const }));
          },
          (at) => vfs.readdir(at),
        ),
      "fs.mkdir": (proc: Proc, path: string, recursive: boolean, mode: number, floor?: string) =>
        this.onPath(
          path,
          (device) => {
            if (recursive && device === "/dev/fd") {
              return undefined;
            }
            throw createSystemError("EEXIST", "mkdir", path);
          },
          (at) => this.creating(proc, () => vfs.mkdir(at, recursive, mode, floor)),
          false,
        ),
      "fs.rmdir": (_proc: Proc, path: string) =>
        this.onPath(
          path,
          (device) => {
            throw createSystemError(device === "/dev/fd" ? "EACCES" : "ENOTDIR", "rmdir", path);
          },
          (at) => vfs.rmdir(at),
          false,
        ),
      "fs.unlink": (_proc: Proc, path: string) =>
        this.onPath(
          path,
          () => {
            throw createSystemError("EACCES", "unlink", path);
          },
          (at) => vfs.unlink(at),
          false,
        ),
      "fs.rm": (_proc: Proc, path: string, recursive: boolean, force: boolean) =>
        this.onPath(
          path,
          () => {
            throw createSystemError("EACCES", "rm", path);
          },
          (at) => vfs.rm(at, recursive, force),
          false,
        ),
      "fs.rename": (_proc: Proc, from: string, to: string) =>
        this.onPaths(
          from,
          to,
          () => {
            throw createSystemError("EACCES", "rename", from, to);
          },
          () => vfs.rename(from, to),
        ),
      "fs.link": (_proc: Proc, existing: string, path: string) =>
        this.onPaths(
          existing,
          path,
          () => {
            // Linux's linkat: the new name first (a device is there), then
            // the protected hard links, which refuse a device the user does
            // not own (`may_linkat`), before the directory's permission.
            const taken = deviceOf(path) ?? this.deviceBehind(path, false);
            throw createSystemError(taken !== null ? "EEXIST" : "EPERM", "link", existing, path);
          },
          () => vfs.link(existing, path),
        ),
      "fs.symlink": (_proc: Proc, target: string, path: string) =>
        this.onPath(
          path,
          () => {
            throw createSystemError("EEXIST", "symlink", target, path);
          },
          (at) => vfs.symlink(target, at),
          false,
        ),
      "fs.readlink": (_proc: Proc, path: string) =>
        this.onPath(
          path,
          () => {
            throw createSystemError("EINVAL", "readlink", path);
          },
          (at) => {
            const target = vfs.readlink(at);
            // A device's own entry (`isDeviceEntry`) is no link to read.
            if (kernelPathOf(target) !== null && isDeviceEntry(vfs.stat(at, false))) {
              throw createSystemError("EINVAL", "readlink", path);
            }
            return target;
          },
          false,
        ),
      "fs.realpath": (proc: Proc, path: string) =>
        this.onPath(
          path,
          (device) => {
            if (!this.deviceExists(proc, device)) {
              throw createSystemError("ENOENT", "realpath", path);
            }
            return device;
          },
          (at) => vfs.realpath(at),
        ),
      "fs.chmod": (_proc: Proc, path: string, mode: number, follow: boolean) =>
        this.onPath(
          path,
          () => {
            throw createSystemError("EPERM", "chmod", path);
          },
          (at) => vfs.chmod(at, mode, follow),
          follow,
        ),
      "fs.utimes": (
        proc: Proc,
        path: string,
        atime: number | null,
        mtime: number | null,
        follow: boolean,
      ) =>
        this.onPath(
          path,
          // A device keeps no times to change, but answers as utimensat(2)
          // does: both set to now (`touch /dev/null`) need write permission,
          // explicit times the owner, which root's devices refuse.
          (device) => {
            const stat = this.deviceStat(proc, device, "utime");
            const rootOwned = stat.uid === ROOT_ID;
            if (atime === null && mtime === null) {
              if ((callerBits(stat.mode, rootOwned) & OWNER_W) === 0) {
                throw createSystemError("EACCES", "utime", path);
              }
            } else if (rootOwned) {
              throw createSystemError("EPERM", "utime", path);
            }
          },
          (at) => vfs.utimes(at, atime, mtime, follow),
          follow,
        ),
      "fs.truncate": (proc: Proc, path: string, length: number) =>
        this.onPath(
          path,
          (device) =>
            this.useDevice(proc, device, (description) => {
              if (description.kind === "file") {
                description.file.truncate(length);
              }
            }),
          (at) => vfs.truncate(at, length),
        ),
      "fs.copyFile": (proc: Proc, source: string, destination: string, mode: number) => {
        let from = deviceOf(source);
        let to = deviceOf(destination);
        if (from === null && to === null) {
          try {
            vfs.copyFile(source, destination, mode);
            return undefined;
          } catch (error) {
            if (!isLinkLoop(error)) {
              throw error;
            }
            const ends = [this.walk(source, true), this.walk(destination, true)];
            const [fromEnd, toEnd] = ends;
            from = fromEnd !== null && "device" in fromEnd ? fromEnd.device : null;
            to = toEnd !== null && "device" in toEnd ? toEnd.device : null;
            if (from === null && to === null) {
              for (const end of ends) {
                if (end !== null && "error" in end) {
                  throw createSystemError(end.error, "copyfile", source, destination);
                }
              }
              throw error;
            }
          }
        }
        if (to !== null && (mode & COPYFILE_EXCL) !== 0) {
          throw createSystemError("EEXIST", "copyfile", source, destination);
        }
        const target = to;
        /** The file end of the copy: what fails there is the copy's failure, named as Node names it. */
        const onFile = <T>(act: () => T): T => {
          try {
            return act();
          } catch (error) {
            const record = toSystemErrorRecord(error);
            throw record ? createSystemError(record.code, "copyfile", source, destination) : error;
          }
        };
        const write = (data: Uint8Array): undefined | Promise<undefined> => {
          if (target !== null) {
            // A pipe may make the copy wait for its reader, as write(2) does.
            return this.writeAllToDevice(proc, target, data);
          }
          const exclusive = (mode & COPYFILE_EXCL) !== 0 ? O_EXCL : 0;
          // The copy gets the device's own mode, whatever the mask and also
          // over a file that was there, as libuv's fchmod gives it.
          const sourceMode =
            from === null ? 0o644 : this.deviceStat(proc, from, "copyfile").mode & 0o7777;
          onFile(() =>
            this.vfs.withUmask(0, () =>
              vfs.writeFile(
                destination,
                data,
                O_WRONLY | O_CREAT | O_TRUNC | exclusive,
                sourceMode,
              ),
            ),
          );
          onFile(() => vfs.chmod(destination, sourceMode, true));
          return undefined;
        };
        // libuv copies as many bytes as fstat reports for the source: a pipe,
        // a terminal or a device reports none, so the copy is made (or
        // emptied) and given nothing; a file behind /dev/stdin or /dev/fd/N
        // is copied whole.
        const data =
          from !== null
            ? this.useDevice(proc, from, (description) =>
                description.kind === "file" ? this.readAll(proc, description) : new Uint8Array(0),
              )
            : onFile(() => vfs.readFile(source));
        return data instanceof Promise ? data.then(write) : write(data);
      },
      "fs.access": (proc: Proc, path: string, mode: number) =>
        this.onPath(
          path,
          (device) => {
            if (!this.deviceExists(proc, device)) {
              throw createSystemError("ENOENT", "access", path);
            }
            // As for a file: the bits of what its stat reports that decide
            // for the user (the others', on a device root owns).
            const bits = accessBits(mode);
            const stat = this.deviceStat(proc, device, "access");
            if ((callerBits(stat.mode, stat.uid === ROOT_ID) & bits) !== bits) {
              throw createSystemError("EACCES", "access", path);
            }
          },
          (at) => vfs.access(at, mode),
        ),
      "fs.mkdtemp": (proc: Proc, prefix: string) => this.creating(proc, () => vfs.mkdtemp(prefix)),
      "fs.readFile": (proc: Proc, path: string) =>
        this.onPath(
          path,
          (device) =>
            this.useDevice(proc, device, (description) => this.readAll(proc, description)),
          (at) => vfs.readFile(at),
        ),
      "fs.writeFile": (proc: Proc, path: string, data: Uint8Array, flags: number, mode: number) =>
        this.onPath<undefined | Promise<undefined>>(
          path,
          (device) => {
            if ((flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0) {
              throw createSystemError("EEXIST", "open", path);
            }
            return this.writeAllToDevice(proc, device, data);
          },
          (at) => {
            this.creating(proc, () => vfs.writeFile(at, data, flags, mode));
            return undefined;
          },
        ),

      // Descriptors
      "fs.open": (proc: Proc, path: string, flags: number, mode: number) =>
        this.allocateFd(
          proc,
          this.onPath<Description>(
            path,
            (device) => {
              if ((flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0) {
                throw createSystemError("EEXIST", "open", path);
              }
              // Only /dev/fd is a directory.
              if ((flags & O_DIRECTORY) !== 0 && device !== "/dev/fd") {
                throw createSystemError("ENOTDIR", "open", path);
              }
              return this.openDevice(proc, device);
            },
            (at) => ({
              kind: "file",
              refs: 1,
              file: this.creating(proc, () => vfs.open(at, flags, mode)),
            }),
            (flags & O_NOFOLLOW) === 0,
          ),
        ),
      "fs.close": (proc: Proc, fd: number) => {
        this.description(proc, fd, "close");
        this.closeFd(proc, fd);
      },
      // With a `token` (a number the worker chose), a read that waits for a
      // pipe or a terminal can be given up with `fs.readCancel`.
      "fs.read": (
        proc: Proc,
        fd: number,
        length: number,
        position: number | null,
        token?: number,
      ) => {
        const description = this.description(proc, fd, "read");
        if (description.kind === "file") {
          return description.file.read(length, position);
        }
        const source = this.source(description);
        if (!source) {
          return new Uint8Array(0);
        }
        return this.readSource(proc, source, length, token);
      },
      // The worker gives up the read it started with `token`: one still
      // waiting is withdrawn and answered with EINTR, and takes nothing. A
      // read answered already is left alone. A post, so it is handled after
      // the read it names.
      "fs.readCancel": (proc: Proc, token: number) => {
        for (const read of proc.pendingReads) {
          if (read.token === token) {
            read.giveUp(createSystemError("EINTR", "read"));
            return;
          }
        }
      },
      // A blocking write: on a full pipe it is answered once its bytes are in.
      "fs.write": (proc: Proc, fd: number, data: Uint8Array, position: number | null) => {
        const description = this.description(proc, fd, "write");
        if (description.kind === "file") {
          return description.file.write(data, position);
        }
        return this.writeTo(proc, description, data, "wait");
      },
      "fs.fstat": (proc: Proc, fd: number) => this.statOf(this.description(proc, fd, "fstat")),
      "fs.ftruncate": (proc: Proc, fd: number, length: number) =>
        this.file(proc, fd, "ftruncate").truncate(length),
      "fs.fchmod": (proc: Proc, fd: number, mode: number) =>
        this.ownersFile(proc, fd, "fchmod").chmod(mode),
      "fs.futimes": (proc: Proc, fd: number, atime: number, mtime: number) =>
        this.ownersFile(proc, fd, "futime").utimes(atime, mtime),
      "fs.fsync": (proc: Proc, fd: number) => {
        this.description(proc, fd, "fsync");
      },
      "fs.watch": (proc: Proc, path: string, recursive: boolean) => {
        const watchId = this.nextWatchId++;
        let watched = path;
        let device: string | null = null;
        const stop = this.onPath(
          path,
          (found) => {
            // A device has nothing to report.
            device = found;
            return () => {};
          },
          () =>
            vfs.watch(path, recursive, (event) => {
              proc.worker.postMessage({
                type: "watch",
                watchId,
                eventType: event.eventType,
                filename: relativeName(watched, event.path, path),
              });
            }),
        );
        // Events carry where the watch really is: `.`, `//` and links resolved.
        watched = device ?? vfs.realpath(path);
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
        let paused = false;
        // From a pipe, what is sent stays in the pipe's count until the
        // process says it received it (`fd.ack`), so a reader that falls
        // behind holds its writer back instead of piling up messages. From a
        // terminal, what is sent is remembered until the process says it
        // handed it to its reader: what it never hands over goes back.
        const pipe = source instanceof Pipe ? source : null;
        const terminal = source instanceof Terminal ? source : null;
        if (terminal) {
          this.joinReaders(proc, terminal);
        }
        const pump = () => {
          cancelWait = null;
          while (!stopped) {
            const onItsWay = pipe ? proc.deliveries.get(fd) : undefined;
            if (onItsWay && onItsWay.pipe === pipe && !onItsWay.empty) {
              // One delivery at a time: the next goes once the worker says
              // it received this one (`delivered` calls `next`), and takes
              // whatever was written meanwhile as one message. That also
              // covers bytes that became the worker's own while it waited
              // in a blocking call.
              return;
            }
            const chunk = pipe
              ? pipe.deliver(DELIVERY_BYTES)
              : source.take(DELIVERY_BYTES, proc.pid);
            if (chunk === undefined) {
              cancelWait = source.whenReadable(proc.pid, pump);
              return;
            }
            if (pipe && chunk) {
              let delivery = proc.deliveries.get(fd);
              if (!delivery || delivery.pipe !== pipe) {
                this.undeliver(proc, fd);
                delivery = new Delivery(pipe);
                proc.deliveries.set(fd, delivery);
              }
              delivery.sent(chunk);
              proc.worker.postMessage({ type: "fd-data", fd, chunk, counted: true });
              continue;
            }
            if (terminal && chunk) {
              let typed = proc.typed.get(fd);
              if (!typed) {
                typed = new TerminalDelivery(terminal);
                proc.typed.set(fd, typed);
              }
              typed.sent(chunk);
              proc.worker.postMessage({ type: "fd-data", fd, chunk, typed: true });
              continue;
            }
            proc.worker.postMessage({ type: "fd-data", fd, chunk });
            if (chunk === null) {
              proc.pumps.delete(fd);
              return;
            }
          }
        };
        proc.pumps.set(fd, {
          stop: () => {
            stopped = true;
            cancelWait?.();
          },
          pause: () => {
            paused = true;
            cancelWait?.();
            cancelWait = null;
          },
          resume: () => {
            paused = false;
            if (!stopped && cancelWait === null) {
              pump();
            }
          },
          next: () => {
            if (!stopped && !paused && cancelWait === null) {
              pump();
            }
          },
        });
        pump();
      },
      "fd.readStop": (proc: Proc, fd: number) => {
        proc.pumps.get(fd)?.stop();
        proc.pumps.delete(fd);
      },
      // A process gives back what it read from a pipe and did not use (a
      // shell's `read` takes a whole chunk), for the next reader: read(2)
      // would have left those bytes there. Whatever was sent to the process
      // and it has not acknowledged goes back after them: what is still on
      // its way, and what reached it with its reader stopped, which it
      // drops (it asks with no `chunks` for that alone). A call: answered
      // after everything sent for the fd before it.
      "fd.unread": (proc: Proc, fd: number, chunks: Uint8Array[]) => {
        const description = this.description(proc, fd, "read");
        if (description.kind !== "pipe-read") {
          throw createSystemError("EINVAL", "read");
        }
        proc.pumps.get(fd)?.stop();
        proc.pumps.delete(fd);
        this.undeliver(proc, fd);
        // In front of what went back: the process had them first.
        description.pipe.unread(chunks, 0);
      },
      // A write with a completion (a call) or none (a post): answered once
      // its bytes are in, and kept when its process ends first.
      "fd.write": (proc: Proc, fd: number, chunk: Uint8Array) =>
        this.writeToFd(proc, fd, chunk, "queue"),
      // The process received `bytes` of what was sent to it on `fd`.
      "fd.ack": (proc: Proc, fd: number, bytes: number) => this.delivered(proc, fd, bytes),
      "fd.close": (proc: Proc, fd: number) => this.closeFd(proc, fd),
      // Nothing: a worker asks so that the answer marks, among the messages
      // it is sent, the point where the kernel had handled all it sent before.
      mark: () => undefined,

      // Terminals
      "tty.setRawMode": (proc: Proc, fd: number, enabled: boolean) => {
        const description = this.description(proc, fd, "ioctl");
        if (description.kind !== "tty") {
          throw createSystemError("ENOTTY", "ioctl");
        }
        // Only the terminal's foreground changes its mode. Linux stops a
        // background process that tries (SIGTTOU); here its request does
        // nothing, as its read of the terminal waits.
        const process = proc.owner ?? proc;
        if (this.inForeground(process, description.terminal)) {
          description.terminal.setRaw(enabled, process.pid);
        }
      },
      // A job-control shell takes the terminal back once a foreground job
      // has ended (tcsetpgrp).
      "tty.reclaim": (proc: Proc, fd: number) => {
        const description = this.description(proc, fd, "ioctl");
        if (description.kind !== "tty") {
          throw createSystemError("ENOTTY", "ioctl");
        }
        this.reclaimTerminal(proc.owner ?? proc, description.terminal);
      },
      // Keys a process read from its terminal but did not use, for the next
      // reader (a shell gives back what was typed after the line it runs).
      "tty.unread": (proc: Proc, fd: number, bytes: Uint8Array) => {
        const description = this.description(proc, fd, "ioctl");
        if (description.kind !== "tty") {
          throw createSystemError("ENOTTY", "ioctl");
        }
        description.terminal.unread(bytes);
      },

      // Processes
      "proc.spawn": (proc: Proc, request: SpawnRequest, ipcToken: string | null) => {
        const { proc: child, stdio } = this.spawnChild(proc, request, ipcToken);
        return { pid: child.pid, stdio };
      },
      "proc.spawnSync": (proc: Proc, request: SpawnSyncRequest) => this.spawnSync(proc, request),
      "proc.kill": (proc: Proc, pid: number, signal: string) => this.kill(proc, pid, signal),
      "proc.exit": (proc: Proc, code: number) => {
        // From a thread this ends the thread; from a process, the process.
        this.finish(proc, { code, signal: null });
        // No answer: the worker is gone.
        return new Promise(() => {});
      },
      "proc.forkAndExit": (proc: Proc, status: ExitStatus) => this.forkAndExit(proc, status),
      "proc.die": (proc: Proc, signal: string) => {
        // A handled signal nobody took: its default action, which may be to do nothing.
        if (!endsByDefault(signal)) {
          return;
        }
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
        // Leaving the terminal's group puts the process in the background.
        if (process.terminal && process.terminal.foregroundGroup !== process.pgid) {
          process.terminal.detach(process.pid);
        }
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
      "module.prepared": (_proc: Proc, filename: string) => this.prepared.locate(filename),
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

  /**
   * `file` for what only the owner may do (fchmod, futimes): on a device root
   * owns (/dev/null) that is EPERM, as fchmod(2) answers a user who is not
   * root, before the kernel's own EINVAL for what is no file.
   */
  private ownersFile(proc: Proc, fd: number, syscall: string): OpenFile {
    const description = this.description(proc, fd, syscall);
    if (description.kind !== "file" && this.statOf(description).uid === ROOT_ID) {
      throw createSystemError("EPERM", syscall);
    }
    return this.file(proc, fd, syscall);
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
   * buffered. The wait is cancelled if `proc` ends first, so a dead reader
   * never takes bytes, and settles, so what it holds is let go. With a
   * `token` the worker can also give the wait up (`fs.readCancel`): the read
   * then takes nothing and fails with EINTR, as read(2) does when a signal
   * handler interrupts it.
   */
  private readSource(
    proc: Proc,
    source: ByteSource,
    length: number,
    token?: number,
  ): Uint8Array | Promise<Uint8Array> {
    if (source instanceof Terminal) {
      this.joinReaders(proc, source);
    }
    const reader = proc.pid;
    const chunk = source.take(length, reader);
    if (chunk !== undefined) {
      return chunk ?? new Uint8Array(0);
    }
    return new Promise((resolve, reject) => {
      let cancelWait = () => {};
      const pending: PendingRead = {
        token,
        giveUp: (error) => {
          proc.pendingReads.delete(pending);
          cancelWait();
          reject(error);
        },
      };
      const retry = () => {
        const next = source.take(length, reader);
        if (next === undefined) {
          cancelWait = source.whenReadable(reader, retry);
        } else {
          proc.pendingReads.delete(pending);
          resolve(next ?? new Uint8Array(0));
        }
      };
      cancelWait = source.whenReadable(reader, retry);
      proc.pendingReads.add(pending);
    });
  }
}

/**
 * `path` relative to the watched `root` (its real path); the root itself is
 * the last segment of the path the caller `asked` to watch.
 */
function relativeName(root: string, path: string, asked: string): string {
  if (path === root) {
    const trimmed = asked.replace(/\/+$/, "");
    const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    return name === "" || name === "." || name === ".."
      ? root.slice(root.lastIndexOf("/") + 1)
      : name;
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

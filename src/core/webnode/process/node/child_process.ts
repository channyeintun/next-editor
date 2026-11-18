// Node's `child_process`: starting other processes. A child is another worker
// the kernel starts; its stdio reaches this process as pipes, and the blocking
// variants (`execSync`, `spawnSync`) wait inside the kernel call.
import { errnoOf, toSystemErrorRecord } from "../../errors";
import { runtime } from "../runtime";
import type { ExitStatus, SpawnRequest, StdioSpec } from "../runtime";
import { Buffer } from "./buffer";
import EventEmitter from "./events";
import type { EventEmitter as EventEmitterInstance } from "./events";
import { nextTick } from "./eventLoop";
import { complete } from "./fs/completion";
import { FdReadable, FdWritable } from "./internal/fdStreams";
import { postIpcDisconnect, postIpcMessage, type IpcEnvelope } from "./internal/ipcEnvelope";
import { AbortError, invalidArgType, makeNodeError } from "./internalErrors";
import { errnoException } from "./net/errors";
import path from "./path";
import { kernelSignalName } from "./signalNames";
import { Readable, Writable } from "./stream";
import { clearTimeout, setTimeout } from "./timers";
import { promisify } from "./util";
import { behindReceivedMessages, listenOnPlatformPort } from "./worker_threads";

/** A `stdio` entry: a keyword, an fd, or a stream over one (`process.stdout`, a child's output). */
type StdioOption = string | number | null | undefined | object;

interface SpawnOptions {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  argv0?: string;
  stdio?: string | StdioOption[];
  shell?: boolean | string;
  timeout?: number;
  killSignal?: string | number;
  signal?: AbortSignal;
  detached?: boolean;
  windowsHide?: boolean;
  encoding?: string | null;
  maxBuffer?: number;
  input?: string | Uint8Array;
  silent?: boolean;
  execPath?: string;
  execArgv?: string[];
  serialization?: string;
}

type ExecCallback = (
  error:
    | (Error & { code?: number | string | null; killed?: boolean; signal?: string | null })
    | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

const DEFAULT_MAX_BUFFER = 1024 * 1024;

function environment(options: SpawnOptions): Record<string, string> {
  const source = options.env ?? runtime().env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      env[key] = String(value);
    }
  }
  return env;
}

/**
 * No `cwd` option: the child stays where this process is, as libuv's child
 * does when Node passes it no cwd, so it starts even where it could not
 * change into (SpawnRequest.inheritCwd).
 */
function inheritsCwd(options: SpawnOptions): boolean {
  return options.cwd === undefined || options.cwd === null;
}

function workingDirectory(options: SpawnOptions): string {
  if (inheritsCwd(options)) {
    return runtime().cwd;
  }
  const text =
    options.cwd instanceof URL ? decodeURIComponent(options.cwd.pathname) : String(options.cwd);
  return path.resolve(text);
}

function normalizeStdio(stdio: SpawnOptions["stdio"], fallback: string): StdioSpec[] {
  const list: StdioOption[] = Array.isArray(stdio)
    ? [...stdio]
    : [stdio ?? fallback, stdio ?? fallback, stdio ?? fallback];
  while (list.length < 3) {
    list.push(undefined);
  }
  return list.map((entry, index): StdioSpec => {
    if (entry === undefined || entry === null) {
      return index < 3 ? "pipe" : "ignore";
    }
    if (entry === "pipe" || entry === "overlapped") {
      return "pipe";
    }
    if (entry === "inherit" || entry === "ignore" || entry === "ipc") {
      return entry;
    }
    if (typeof entry === "number") {
      return entry;
    }
    const fd = typeof entry === "object" ? (entry as { fd?: unknown }).fd : undefined;
    if (typeof fd === "number") {
      return fd;
    }
    throw Object.assign(
      new TypeError(`The argument 'stdio' is invalid. Received '${String(entry)}'`),
      {
        code: "ERR_INVALID_ARG_VALUE",
      },
    );
  });
}

/** What actually runs for `file` with `args`: through a shell when `shell` is set. */
function commandFor(
  file: string,
  args: string[],
  options: SpawnOptions,
): { command: string; args: string[] } {
  if (!options.shell) {
    return { command: file, args };
  }
  const line = [file, ...args].join(" ");
  return {
    command: typeof options.shell === "string" ? options.shell : "sh",
    args: ["-c", line],
  };
}

function spawnError(command: string, args: string[], error: unknown): Error {
  const record = toSystemErrorRecord(error);
  if (!record) {
    return error instanceof Error ? error : new Error(String(error));
  }
  // The fields in the order Node's ErrnoException has them.
  const failure = new Error(`spawn ${command} ${record.code}`) as Error & Record<string, unknown>;
  failure.errno = (error as { errno?: number }).errno;
  failure.code = record.code;
  failure.syscall = `spawn ${command}`;
  failure.path = command;
  failure.spawnargs = args;
  return failure;
}

/**
 * How long a parent waits for the exit envelope (`postIpcExit`) of a child
 * that exited with a code but never sent it (its worker failed before it could).
 */
const IPC_DRAIN_TIMEOUT_MS = 1000;

export interface ChildProcess extends EventEmitterInstance {
  pid: number | undefined;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  stdio: (Readable | Writable | null)[];
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  connected: boolean;
  spawnfile: string;
  spawnargs: string[];
  kill(signal?: string | number): boolean;
  /** Only on a child started with an IPC channel, as in Node. */
  send(message: unknown, ...rest: unknown[]): boolean;
  /** Only on a child started with an IPC channel, as in Node. */
  disconnect(): void;
  ref(): void;
  unref(): void;
}

interface ChildProcessConstructor {
  new (): ChildProcess;
  prototype: ChildProcess;
}

/** The `ChildProcess` class: a handle on a started child. */
export const ChildProcess = function ChildProcess(this: ChildProcess) {
  EventEmitter.call(this);
  this.pid = undefined;
  this.stdin = null;
  this.stdout = null;
  this.stderr = null;
  this.stdio = [];
  this.exitCode = null;
  this.signalCode = null;
  this.killed = false;
  this.connected = false;
  this.spawnfile = "";
  this.spawnargs = [];
} as unknown as ChildProcessConstructor;
Object.setPrototypeOf(ChildProcess.prototype, EventEmitter.prototype);
Object.setPrototypeOf(ChildProcess, EventEmitter);

/** A started child, as its handle's methods see it. */
interface Started {
  pid: number;
  /** The kernel has reported its exit. */
  exited: boolean;
  /** It holds the process open until it exits (`ref`/`unref`). */
  reffed: boolean;
}

/** Each child that started. One that could not has no entry, as Node's has no handle. */
const startedChildren = new WeakMap<ChildProcess, Started>();

// `kill`, `ref` and `unref` are on the prototype, as in Node, so every child
// has them: for one that could not start, `kill` answers false and the other
// two do nothing.
ChildProcess.prototype.kill = function kill(this: ChildProcess, signal?: string | number) {
  // An unknown signal is the caller's mistake whatever became of the child.
  const name = kernelSignalName(signal);
  const started = startedChildren.get(this);
  if (!started || started.exited) {
    return false;
  }
  try {
    runtime().processes.kill(started.pid, name);
  } catch {
    // Gone already.
    return false;
  }
  this.killed = true;
  return true;
};
ChildProcess.prototype.ref = function ref(this: ChildProcess) {
  const started = startedChildren.get(this);
  if (started && !started.reffed && !started.exited) {
    started.reffed = true;
    runtime().ref();
  }
};
ChildProcess.prototype.unref = function unref(this: ChildProcess) {
  const started = startedChildren.get(this);
  if (started?.reffed) {
    started.reffed = false;
    runtime().unref();
  }
};

/**
 * The output streams of this process's children. Given to another child as
 * its stdio (`stdio: [first.stdout, …]`), such a stream stops reading, as
 * Node stops a socket it hands to a child: the pipe is the new child's to
 * read. Maps each stream to whether it was given away.
 */
const childOutputs = new WeakMap<object, boolean>();

/** Stops this process reading each child output stream in `stdio` (`childOutputs`). */
function handOverStreams(stdio: SpawnOptions["stdio"]): void {
  if (!Array.isArray(stdio)) {
    return;
  }
  for (const entry of stdio) {
    if (entry instanceof FdReadable && childOutputs.has(entry) && !entry.destroyed) {
      childOutputs.set(entry, true);
      entry.handOver();
    }
  }
}

function start(child: ChildProcess, file: string, args: string[], options: SpawnOptions): void {
  const rt = runtime();
  const { command, args: commandArgs } = commandFor(file, args, options);
  const stdio = normalizeStdio(options.stdio, "pipe");
  child.spawnfile = command;
  child.spawnargs = [command, ...commandArgs];

  const request: SpawnRequest = {
    command,
    args: commandArgs,
    cwd: workingDirectory(options),
    inheritCwd: inheritsCwd(options),
    env: environment(options),
    stdio,
    argv0: options.argv0,
    // `detached`: the child leads a process group of its own, as after
    // setsid(2), so `process.kill(-child.pid)` reaches it and what it starts.
    newGroup: options.detached === true ? true : undefined,
  };

  // Before the child exists: it must find in the pipe what this process had
  // not yet been handed.
  handOverStreams(options.stdio);
  let handle;
  try {
    handle = rt.processes.spawn(request);
  } catch (error) {
    const failure = spawnError(command, commandArgs, error);
    const errno = (failure as { errno?: unknown }).errno;
    failedStart(child, stdio, failure, typeof errno === "number" ? errno : -2);
    return;
  }
  // Node's onSpawnNT: queued before anything else spawn() queues.
  nextTick(() => child.emit("spawn"));

  child.pid = handle.pid;
  const started: Started = { pid: handle.pid, exited: false, reffed: true };
  startedChildren.set(child, started);
  rt.ref();
  let openStreams = 0;
  /** 'exit' was emitted: the kernel reported the exit and the IPC channel has ended. */
  let exitEmitted = false;
  let closed = false;
  const maybeClose = () => {
    if (exitEmitted && openStreams === 0 && !closed) {
      closed = true;
      child.emit("close", child.exitCode, child.signalCode);
    }
  };

  child.stdio = handle.stdio.map((fd, index) => {
    if (fd === null) {
      return null;
    }
    if (index === 0) {
      // Ending stdin closes the pipe, which is the child's end of input.
      const input = new FdWritable(fd);
      input.on("error", () => {});
      return input;
    }
    const output = new FdReadable(fd);
    childOutputs.set(output, false);
    openStreams += 1;
    output.on("close", () => {
      openStreams -= 1;
      maybeClose();
    });
    // As Node's child sockets do: start reading at once, into the stream's
    // buffer up to its highWaterMark, so the child can write that much more
    // than the pipe holds before it waits for a reader.
    output.read(0);
    return output;
  });
  child.stdin = (child.stdio[0] as FdWritable | null) ?? null;
  child.stdout = (child.stdio[1] as FdReadable | null) ?? null;
  child.stderr = (child.stdio[2] as FdReadable | null) ?? null;

  const ipc = handle.ipc;
  /** The exit the kernel reported, until 'exit' has been emitted for it. */
  let pendingExit: ExitStatus | null = null;
  /** Ends a wait for the last of an exited child's messages that never came. */
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the child's exit envelope has arrived: every message it sent came
   * before it, so its exit is emitted as soon as the kernel reports it.
   */
  let exitSaid = false;
  const emitExit = () => {
    const status = pendingExit;
    if (status === null) {
      return;
    }
    pendingExit = null;
    if (drainTimer) {
      clearTimeout(drainTimer);
    }
    exitEmitted = true;
    child.exitCode = status.code;
    child.signalCode = status.signal;
    if (child.connected) {
      child.connected = false;
      ipc?.close();
      child.emit("disconnect");
    }
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.destroy();
    }
    child.emit("exit", status.code, status.signal);
    // Output nobody is reading is drained, so its streams end and `close`
    // follows. Not a stream given to another child, which reads it now.
    for (const stream of [child.stdout, child.stderr]) {
      if (
        stream &&
        !stream.destroyed &&
        stream.readableFlowing !== true &&
        childOutputs.get(stream) !== true
      ) {
        stream.resume();
      }
    }
    if (started.reffed) {
      started.reffed = false;
      rt.unref();
    }
    maybeClose();
  };

  if (ipc) {
    child.connected = true;
    listenOnPlatformPort(ipc, (event: MessageEvent<IpcEnvelope>) => {
      const data = event.data;
      if (data.type === "message") {
        child.emit("message", data.message, undefined);
      } else if (data.type === "disconnect") {
        if (child.connected) {
          child.connected = false;
          ipc.close();
          child.emit("disconnect");
        }
        // Nothing follows a disconnect on the channel.
        emitExit();
      } else if (data.type === "exit") {
        exitSaid = true;
        emitExit();
      }
    });
    // `send` and `disconnect` come with the channel, as in Node.
    const channelClosed = () => makeNodeError("ERR_IPC_CHANNEL_CLOSED", "Channel closed", Error);
    child.send = (message, ...rest) => {
      const callback = rest.find((item) => typeof item === "function") as
        | ((error: Error | null) => void)
        | undefined;
      if (!child.connected) {
        const error = channelClosed();
        if (callback) {
          nextTick(callback, error);
        } else {
          nextTick(() => child.emit("error", error));
        }
        return false;
      }
      postIpcMessage(ipc, message);
      // A message is handed over at once, as Node's write to the channel that
      // completes synchronously: its callback follows in a tick.
      if (callback) {
        nextTick(callback, null);
      }
      return true;
    };
    child.disconnect = () => {
      if (!child.connected) {
        child.emit(
          "error",
          makeNodeError("ERR_IPC_DISCONNECTED", "IPC channel is already disconnected", Error),
        );
        return;
      }
      child.connected = false;
      postIpcDisconnect(ipc);
      ipc.close();
      nextTick(() => {
        child.emit("disconnect");
        // The channel is closed here: nothing more arrives on it.
        emitExit();
      });
    };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (options.timeout && options.timeout > 0) {
    timer = setTimeout(() => child.kill(options.killSignal ?? "SIGTERM"), options.timeout);
  }
  const onAbort = () => {
    child.kill(options.killSignal ?? "SIGTERM");
    child.emit("error", new AbortError(undefined, { cause: options.signal?.reason }));
  };
  if (options.signal) {
    if (options.signal.aborted) {
      // After 'spawn', as Node queues it after child.spawn().
      nextTick(onAbort);
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  rt.processes.onExit(handle.pid, (status: ExitStatus) => {
    started.exited = true;
    if (timer) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onAbort);
    pendingExit = status;
    // As in Node, the messages a child sent come before 'disconnect' and
    // 'exit'. One that exited by itself said so last on its IPC channel
    // (`postIpcExit`): when that has come, so has everything it sent, and
    // when it has not, what it sent before may still be on its way. One a
    // signal ended said nothing more: what it sent is on the channel already,
    // received or nearly, and is delivered first. One whose channel is
    // closed has nothing more to give.
    if (ipc && child.connected && !exitSaid) {
      // The child still holds the process open, as before its exit.
      if (status.signal === null) {
        drainTimer = setTimeout(emitExit, IPC_DRAIN_TIMEOUT_MS).unref();
      } else {
        behindReceivedMessages(emitExit);
      }
      return;
    }
    emitExit();
  });
}

/**
 * A child that could not start, as Node reports one. It still has the stdio
 * streams it asked for, over pipes whose other ends were never opened. From a
 * tick after `spawn()` returns (onErrorNT, then onexit): stdin goes, then
 * 'error', with the negative errno as the exit code (-2 for ENOENT); a write
 * that was on its way fails with EPIPE without an 'error' event. Each output
 * stream then reads its end from the event loop and ends, then closes in a
 * later task, and 'close' follows the last of them. With no output streams 'close' follows
 * 'error' at once, or, with an IPC channel, from the event loop. stdin's own
 * 'close' comes after the child's, from the event loop.
 */
function failedStart(
  child: ChildProcess,
  stdio: StdioSpec[],
  failure: Error,
  exitCode: number,
): void {
  const writesOnTheirWay: ((error: Error) => void)[] = [];
  const outputs: Readable[] = [];
  child.stdio = stdio.map((spec, index) => {
    if (spec !== "pipe") {
      return null;
    }
    if (index === 0) {
      return new Writable({
        // Its 'close' is emitted below, after the child's, as in Node, where
        // stdin's handle is the last of the child's to close.
        emitClose: false,
        write(_chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
          writesOnTheirWay.push(callback);
        },
      });
    }
    // Ended, a pipe closes from the event loop, as a socket's handle does.
    const output = new Readable({ read() {}, autoDestroy: false });
    output.once("end", () => complete(() => output.destroy()));
    outputs.push(output);
    return output;
  });
  child.stdin = (child.stdio[0] as Writable | null) ?? null;
  child.stdout = (child.stdio[1] as Readable | null) ?? null;
  child.stderr = (child.stdio[2] as Readable | null) ?? null;

  const emitClose = () => child.emit("close", child.exitCode, null);
  const closeStdin = () => child.stdin?.emit("close");
  let open = outputs.length;
  for (const output of outputs) {
    output.on("close", () => {
      open -= 1;
      if (open === 0) {
        emitClose();
        closeStdin();
      }
    });
  }
  nextTick(() => {
    child.exitCode = exitCode;
    child.stdin?.destroy();
    child.emit("error", failure);
    for (const callback of writesOnTheirWay.splice(0)) {
      callback(errnoException("EPIPE", "write"));
    }
    if (outputs.length > 0) {
      complete(() => {
        for (const output of outputs) {
          output.push(null);
          // Read to the end even if nobody does, as Node's flushStdio does.
          if (output.readableFlowing !== true) {
            output.resume();
          }
        }
      });
    } else if (stdio.includes("ipc")) {
      complete(() => {
        emitClose();
        closeStdin();
      });
    } else {
      emitClose();
      complete(closeStdin);
    }
  });
}

function parseSpawnArguments(
  argsOrOptions?: readonly string[] | SpawnOptions | null,
  maybeOptions?: SpawnOptions | null,
): { args: string[]; options: SpawnOptions } {
  if (Array.isArray(argsOrOptions)) {
    return { args: argsOrOptions.map(String), options: maybeOptions ?? {} };
  }
  return {
    args: [],
    options: (argsOrOptions as SpawnOptions | null | undefined) ?? maybeOptions ?? {},
  };
}

/** Starts `command` and returns its handle at once. */
export function spawn(
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions | null,
  maybeOptions?: SpawnOptions | null,
): ChildProcess {
  if (typeof command !== "string") {
    throw invalidArgType("file", "string", command);
  }
  const { args, options } = parseSpawnArguments(argsOrOptions, maybeOptions);
  const child = new ChildProcess();
  start(child, command, args, options);
  return child;
}

function collect(
  child: ChildProcess,
  options: SpawnOptions,
  callback: ExecCallback | undefined,
  commandLine: string,
): void {
  const encoding = options.encoding === undefined ? "utf8" : options.encoding;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const chunks: [Buffer[], Buffer[]] = [[], []];
  const sizes = [0, 0];
  /** What ended the collecting early: an output past `maxBuffer`, or the child's 'error'. */
  let failure: (Error & { cmd?: string }) | null = null;
  let killed = false;

  /** Stops collecting: nothing more is read from the child. */
  const stopReading = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  };

  const gather = (stream: Readable | null, index: 0 | 1) => {
    stream?.on("data", (chunk: Uint8Array) => {
      const buffer = Buffer.from(chunk);
      const room = maxBuffer - sizes[index];
      sizes[index] += buffer.byteLength;
      if (buffer.byteLength <= room) {
        chunks[index].push(buffer);
        return;
      }
      // As Node: the output is kept up to `maxBuffer`, and the child is ended.
      chunks[index].push(buffer.subarray(0, room));
      failure = makeNodeError(
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        `${index === 0 ? "stdout" : "stderr"} maxBuffer length exceeded`,
        RangeError,
      );
      stopReading();
      killed = true;
      child.kill(options.killSignal ?? "SIGTERM");
    });
  };
  gather(child.stdout, 0);
  gather(child.stderr, 1);

  const output = (index: 0 | 1): string | Buffer => {
    const buffer = Buffer.concat(chunks[index]);
    return encoding && encoding !== "buffer" ? buffer.toString(encoding as BufferEncoding) : buffer;
  };

  let done = false;
  const finish = (code: number | null, signal: string | null) => {
    if (done) {
      return;
    }
    done = true;
    if (!callback) {
      return;
    }
    const stdout = output(0);
    const stderr = output(1);
    if (!failure && code === 0 && signal === null) {
      callback(null, stdout, stderr);
      return;
    }
    const error: Error & { cmd?: string } =
      failure ??
      Object.assign(new Error(`Command failed: ${commandLine}\n${String(stderr)}`), {
        code,
        killed: child.killed || killed,
        signal,
      });
    error.cmd = commandLine;
    callback(error as Parameters<ExecCallback>[0], stdout, stderr);
  };

  child.on("error", (error: Error) => {
    // As Node's errorhandler: the callback gets the error at once, with what
    // was read so far.
    failure = error;
    stopReading();
    finish(null, null);
  });
  child.on("close", finish);
}

/** Runs a shell command line and gives its output to `callback`. */
export function exec(
  command: string,
  optionsOrCallback?: SpawnOptions | ExecCallback | null,
  maybeCallback?: ExecCallback,
): ChildProcess {
  const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  const options: SpawnOptions =
    typeof optionsOrCallback === "object" && optionsOrCallback ? optionsOrCallback : {};
  const child = spawn(command, [], { ...options, shell: options.shell ?? true });
  collect(child, options, callback, command);
  return child;
}

/** Runs a file with arguments and gives its output to `callback`. */
export function execFile(
  file: string,
  ...rest: (readonly string[] | SpawnOptions | ExecCallback | null | undefined)[]
): ChildProcess {
  const callback = rest.find((item): item is ExecCallback => typeof item === "function");
  const args = rest.find((item): item is readonly string[] => Array.isArray(item)) ?? [];
  const options =
    rest.find(
      (item): item is SpawnOptions =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    ) ?? {};
  const child = spawn(file, args, options);
  collect(child, options, callback, [file, ...args].join(" "));
  return child;
}

/** Starts a Node module as a child with a message channel to this process. */
export function fork(
  modulePath: string | URL,
  argsOrOptions?: readonly string[] | SpawnOptions | null,
  maybeOptions?: SpawnOptions | null,
): ChildProcess {
  const { args, options } = parseSpawnArguments(argsOrOptions, maybeOptions);
  const script =
    modulePath instanceof URL ? decodeURIComponent(modulePath.pathname) : String(modulePath);
  let stdio = options.stdio;
  if (stdio === undefined) {
    stdio = options.silent
      ? ["pipe", "pipe", "pipe", "ipc"]
      : ["inherit", "inherit", "inherit", "ipc"];
  } else if (typeof stdio === "string") {
    stdio = [stdio, stdio, stdio, "ipc"];
  } else if (!stdio.includes("ipc")) {
    throw Object.assign(
      new Error("Forked processes must have an IPC channel, missing value 'ipc' in options.stdio"),
      {
        code: "ERR_CHILD_PROCESS_IPC_REQUIRED",
      },
    );
  }
  const execArgv = options.execArgv ?? withoutEval(runtime().execArgv);
  return spawn(options.execPath ?? "node", [...execArgv, script, ...args], { ...options, stdio });
}

const EVAL_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);

/**
 * The parent's options without its `-e`/`-p` code, as Node's fork leaves them
 * out: the child would run that code again, and fork again, without end.
 */
function withoutEval(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const option = execArgv[index];
    if (EVAL_OPTIONS.has(option)) {
      index += 1;
    } else if (!/^--(?:eval|print)=/.test(option)) {
      kept.push(option);
    }
  }
  return kept;
}

interface SyncResult {
  error?: Error;
  status: number | null;
  signal: string | null;
  /** Null for a child that could not start, whose `stdout` and `stderr` are then undefined. */
  output: (Buffer | string | null)[] | null;
  pid: number;
  stdout: Buffer | string | undefined;
  stderr: Buffer | string | undefined;
}

/** Linux's errno for ENOBUFS and ETIMEDOUT, which only `spawnSync` reports. */
const SPAWN_SYNC_ERRNO = { ENOBUFS: -105, ETIMEDOUT: -110 };

function runSync(file: string, args: string[], options: SpawnOptions): SyncResult {
  const rt = runtime();
  const { command, args: commandArgs } = commandFor(file, args, options);
  const input =
    options.input === undefined
      ? undefined
      : typeof options.input === "string"
        ? new TextEncoder().encode(options.input)
        : new Uint8Array(options.input);
  handOverStreams(options.stdio);
  const result = rt.processes.spawnSync({
    command,
    args: commandArgs,
    cwd: workingDirectory(options),
    inheritCwd: inheritsCwd(options),
    env: environment(options),
    stdio: normalizeStdio(options.stdio, "pipe"),
    argv0: options.argv0,
    input,
    timeoutMs: options.timeout,
    // Node's default for spawnSync, execSync and execFileSync alike.
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    killSignal: options.killSignal === undefined ? undefined : kernelSignalName(options.killSignal),
  });

  /** Node's error for a run that failed with `code`: `spawnSync <command> <code>`. */
  const failure = (code: string, errno: number): Error =>
    Object.assign(new Error(`spawnSync ${command} ${code}`), {
      errno,
      code,
      syscall: `spawnSync ${command}`,
      path: command,
      spawnargs: commandArgs,
    });
  let error: Error | undefined;
  if (result.error === "ETIMEDOUT" || result.error === "ENOBUFS") {
    error = failure(result.error, SPAWN_SYNC_ERRNO[result.error]);
  } else if (result.error) {
    // A failed start (ENOENT, EACCES), or EPIPE: the child ended before taking all of `input`.
    error = failure(result.error.code, -errnoOf(result.error.code));
  }

  // The keys in Node's order: `error` first, when there is one.
  const sync = (error === undefined ? {} : { error }) as SyncResult;
  sync.status = result.status.code;
  sync.signal = result.status.signal;
  if (result.pid === 0) {
    // The child never started: there is no output, as in Node.
    sync.output = null;
    sync.pid = 0;
    sync.stdout = undefined;
    sync.stderr = undefined;
    return sync;
  }
  const encoding = options.encoding && options.encoding !== "buffer" ? options.encoding : null;
  const convert = (bytes: Uint8Array): Buffer | string => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return encoding ? buffer.toString(encoding as BufferEncoding) : buffer;
  };
  const stdout = convert(result.stdout);
  const stderr = convert(result.stderr);
  sync.output = [null, stdout, stderr];
  sync.pid = result.pid;
  sync.stdout = stdout;
  sync.stderr = stderr;
  return sync;
}

/** Runs `command` to its exit, blocking, and returns everything about the run. */
export function spawnSync(
  command: string,
  argsOrOptions?: readonly string[] | SpawnOptions | null,
  maybeOptions?: SpawnOptions | null,
): SyncResult {
  const { args, options } = parseSpawnArguments(argsOrOptions, maybeOptions);
  return runSync(command, args, options);
}

function checkSync(
  result: SyncResult,
  commandLine: string,
  options: SpawnOptions,
): Buffer | string {
  if (result.error) {
    throw Object.assign(result.error, result);
  }
  if (result.status !== 0) {
    const stderr = result.stderr === undefined ? "" : String(result.stderr);
    const error = Object.assign(
      new Error(`Command failed: ${commandLine}${stderr ? `\n${stderr}` : ""}`),
      result,
    );
    throw error;
  }
  // With inherited stdio there is nothing to return.
  const stdio = options.stdio;
  if (stdio === "inherit" || (Array.isArray(stdio) && stdio[1] === "inherit")) {
    return Buffer.alloc(0);
  }
  return result.stdout ?? Buffer.alloc(0);
}

/**
 * What `execSync` and `execFileSync` do with the child's stderr when the
 * caller chose no `stdio`, as Node does: it is captured like stdout, so a
 * failure's error carries it (`error.stderr`, and in its message), and
 * passed on to this process's stderr once the child has ended.
 */
function passOnStderr(result: SyncResult, options: SpawnOptions): void {
  if (options.stdio !== undefined && options.stdio !== null) {
    return;
  }
  const stderr = result.stderr;
  if (stderr === undefined || stderr.length === 0) {
    return;
  }
  const process = (globalThis as { process?: { stderr?: { write(chunk: unknown): unknown } } })
    .process;
  process?.stderr?.write(stderr);
}

/** Runs a shell command line, blocking, and returns its stdout. Throws on a non-zero exit. */
export function execSync(command: string, options: SpawnOptions = {}): Buffer | string {
  const result = runSync(command, [], { ...options, shell: options.shell ?? true });
  passOnStderr(result, options);
  return checkSync(result, command, options);
}

/** Runs a file with arguments, blocking, and returns its stdout. Throws on a non-zero exit. */
export function execFileSync(
  file: string,
  argsOrOptions?: readonly string[] | SpawnOptions | null,
  maybeOptions?: SpawnOptions | null,
): Buffer | string {
  const { args, options } = parseSpawnArguments(argsOrOptions, maybeOptions);
  const result = runSync(file, args, options);
  passOnStderr(result, options);
  return checkSync(result, [file, ...args].join(" "), options);
}

const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

function promiseVariant(
  run: (callback: ExecCallback) => ChildProcess,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> & { child: ChildProcess } {
  let child!: ChildProcess;
  const promise = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>(
    (resolve, reject) => {
      child = run((error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
        } else {
          resolve({ stdout, stderr });
        }
      });
    },
  ) as Promise<{ stdout: string | Buffer; stderr: string | Buffer }> & { child: ChildProcess };
  promise.child = child;
  return promise;
}

Object.defineProperty(exec, promisifyCustom, {
  value: (command: string, options?: SpawnOptions) =>
    promiseVariant((callback) => exec(command, options, callback)),
});
Object.defineProperty(execFile, promisifyCustom, {
  value: (file: string, args?: readonly string[], options?: SpawnOptions) =>
    promiseVariant((callback) => execFile(file, args, options, callback)),
});

void promisify;

export default {
  ChildProcess,
  spawn,
  exec,
  execFile,
  fork,
  spawnSync,
  execSync,
  execFileSync,
  _forkChild() {},
};

// Node's `child_process`: starting other processes. A child is another worker
// the kernel starts; its stdio reaches this process as pipes, and the blocking
// variants (`execSync`, `spawnSync`) wait inside the kernel call.
import { toSystemErrorRecord } from "../../errors";
import { runtime } from "../runtime";
import type { ExitStatus, SpawnRequest, StdioSpec } from "../runtime";
import { Buffer } from "./buffer";
import EventEmitter from "./events";
import type { EventEmitter as EventEmitterInstance } from "./events";
import { FdReadable, FdWritable } from "./internal/fdStreams";
import { invalidArgType } from "./internalErrors";
import path from "./path";
import { signalName, signalNumber } from "./process";
import { promisify } from "./util";

type StdioOption = string | number | null | undefined | { fd?: number };

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
  error: (Error & { code?: number | string; killed?: boolean; signal?: string | null }) | null,
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

function workingDirectory(options: SpawnOptions): string {
  if (options.cwd === undefined || options.cwd === null) {
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
    if (typeof entry === "object" && typeof entry.fd === "number") {
      return entry.fd;
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
  const failure = new Error(`spawn ${command} ${record.code}`) as Error & Record<string, unknown>;
  failure.code = record.code;
  failure.errno = (error as { errno?: number }).errno;
  failure.syscall = `spawn ${command}`;
  failure.path = command;
  failure.spawnargs = args;
  return failure;
}

export interface ChildProcess extends EventEmitterInstance {
  pid: number | undefined;
  stdin: FdWritable | null;
  stdout: FdReadable | null;
  stderr: FdReadable | null;
  stdio: (FdReadable | FdWritable | null)[];
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  connected: boolean;
  spawnfile: string;
  spawnargs: string[];
  kill(signal?: string | number): boolean;
  send(message: unknown, ...rest: unknown[]): boolean;
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
    env: environment(options),
    stdio,
    argv0: options.argv0,
  };

  let handle;
  try {
    handle = rt.processes.spawn(request);
  } catch (error) {
    const failure = spawnError(command, commandArgs, error);
    // Node reports a failed spawn as an `error` event, after `spawn()` returns,
    // then `close` with the negative errno as the exit code (-2 for ENOENT).
    const errno = (failure as { errno?: unknown }).errno;
    child.exitCode = typeof errno === "number" ? errno : -2;
    queueMicrotask(() => {
      child.emit("error", failure);
      child.emit("close", child.exitCode, null);
    });
    return;
  }

  child.pid = handle.pid;
  let reffed = true;
  rt.ref();
  let openStreams = 0;
  let exited = false;
  let closed = false;
  const maybeClose = () => {
    if (exited && openStreams === 0 && !closed) {
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
    openStreams += 1;
    output.on("close", () => {
      openStreams -= 1;
      maybeClose();
    });
    return output;
  });
  child.stdin = (child.stdio[0] as FdWritable | null) ?? null;
  child.stdout = (child.stdio[1] as FdReadable | null) ?? null;
  child.stderr = (child.stdio[2] as FdReadable | null) ?? null;

  const ipc = handle.ipc;
  if (ipc) {
    child.connected = true;
    ipc.onmessage = (event: MessageEvent<{ type: string; message?: unknown }>) => {
      if (event.data.type === "message") {
        child.emit("message", event.data.message, undefined);
      } else if (event.data.type === "disconnect" && child.connected) {
        child.connected = false;
        child.emit("disconnect");
      }
    };
  }

  child.kill = (signal) => {
    if (exited || child.pid === undefined) {
      return false;
    }
    try {
      rt.processes.kill(child.pid, signalName(signal));
      child.killed = true;
      return true;
    } catch {
      return false;
    }
  };
  child.send = (message, ...rest) => {
    const callback = rest.find((item) => typeof item === "function") as
      | ((error: Error | null) => void)
      | undefined;
    if (!ipc || !child.connected) {
      const error = Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
      if (callback) {
        queueMicrotask(() => callback(error));
      } else {
        queueMicrotask(() => child.emit("error", error));
      }
      return false;
    }
    ipc.postMessage({ type: "message", message });
    if (callback) {
      queueMicrotask(() => callback(null));
    }
    return true;
  };
  child.disconnect = () => {
    if (!ipc || !child.connected) {
      return;
    }
    child.connected = false;
    ipc.postMessage({ type: "disconnect" });
    ipc.close();
    queueMicrotask(() => child.emit("disconnect"));
  };
  child.ref = () => {
    if (!reffed && !exited) {
      reffed = true;
      rt.ref();
    }
  };
  child.unref = () => {
    if (reffed) {
      reffed = false;
      rt.unref();
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (options.timeout && options.timeout > 0) {
    timer = setTimeout(() => child.kill(options.killSignal ?? "SIGTERM"), options.timeout);
  }
  const onAbort = () => {
    child.kill(options.killSignal ?? "SIGTERM");
    child.emit(
      "error",
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
        cause: options.signal?.reason,
      }),
    );
  };
  if (options.signal) {
    if (options.signal.aborted) {
      queueMicrotask(onAbort);
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  rt.processes.onExit(handle.pid, (status: ExitStatus) => {
    exited = true;
    if (timer) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onAbort);
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
    // Output nobody is reading is drained, so its streams end and `close` follows.
    for (const stream of [child.stdout, child.stderr]) {
      if (stream && !stream.destroyed && stream.readableFlowing !== true) {
        stream.resume();
      }
    }
    if (reffed) {
      reffed = false;
      rt.unref();
    }
    maybeClose();
  });

  queueMicrotask(() => child.emit("spawn"));
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
  let overflow: Error | null = null;
  let spawnFailure: Error | null = null;

  const gather = (stream: FdReadable | null, index: 0 | 1) => {
    stream?.on("data", (chunk: Uint8Array) => {
      const buffer = Buffer.from(chunk);
      sizes[index] += buffer.byteLength;
      if (sizes[index] > maxBuffer && !overflow) {
        overflow = Object.assign(
          new RangeError(`${index === 0 ? "stdout" : "stderr"} maxBuffer length exceeded`),
          { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
        );
        child.kill(options.killSignal ?? "SIGTERM");
        return;
      }
      chunks[index].push(buffer);
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
    if (spawnFailure) {
      callback(spawnFailure as Parameters<ExecCallback>[0], stdout, stderr);
      return;
    }
    if (overflow || code !== 0 || signal !== null) {
      const error = (overflow ??
        new Error(`Command failed: ${commandLine}\n${String(stderr)}`)) as NonNullable<
        Parameters<ExecCallback>[0]
      > &
        Record<string, unknown>;
      error.code = overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : (code ?? undefined);
      error.killed = child.killed;
      error.signal = signal;
      error.cmd = commandLine;
      error.stdout = stdout;
      error.stderr = stderr;
      callback(error, stdout, stderr);
      return;
    }
    callback(null, stdout, stderr);
  };

  child.on("error", (error: Error) => {
    spawnFailure = error;
    if (child.pid === undefined) {
      finish(null, null);
    }
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
  const execArgv = options.execArgv ?? runtime().execArgv;
  return spawn(options.execPath ?? "node", [...execArgv, script, ...args], { ...options, stdio });
}

interface SyncResult {
  pid: number;
  output: (Buffer | string | null)[];
  stdout: Buffer | string;
  stderr: Buffer | string;
  status: number | null;
  signal: string | null;
  error?: Error;
}

function runSync(file: string, args: string[], options: SpawnOptions): SyncResult {
  const rt = runtime();
  const { command, args: commandArgs } = commandFor(file, args, options);
  const input =
    options.input === undefined
      ? undefined
      : typeof options.input === "string"
        ? new TextEncoder().encode(options.input)
        : new Uint8Array(options.input);
  const result = rt.processes.spawnSync({
    command,
    args: commandArgs,
    cwd: workingDirectory(options),
    env: environment(options),
    stdio: normalizeStdio(options.stdio, "pipe"),
    argv0: options.argv0,
    input,
    timeoutMs: options.timeout,
    maxBuffer: options.maxBuffer,
    killSignal: options.killSignal === undefined ? undefined : signalName(options.killSignal),
  });

  const encoding = options.encoding && options.encoding !== "buffer" ? options.encoding : null;
  const convert = (bytes: Uint8Array): Buffer | string => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return encoding ? buffer.toString(encoding as BufferEncoding) : buffer;
  };
  const stdout = convert(result.stdout);
  const stderr = convert(result.stderr);
  const sync: SyncResult = {
    pid: result.pid,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: result.status.code,
    signal: result.status.signal,
  };
  if (result.error === "ETIMEDOUT") {
    sync.error = Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), {
      code: "ETIMEDOUT",
      errno: -110,
      syscall: `spawnSync ${command}`,
      path: command,
      spawnargs: commandArgs,
    });
  } else if (result.error === "ENOBUFS") {
    sync.error = Object.assign(new Error(`spawnSync ${command} ENOBUFS`), {
      code: "ENOBUFS",
      syscall: `spawnSync ${command}`,
    });
  } else if (result.error) {
    sync.error = Object.assign(new Error(`spawnSync ${command} ${result.error.code}`), {
      code: result.error.code,
      syscall: `spawnSync ${command}`,
      path: command,
      spawnargs: commandArgs,
    });
  }
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
    const stderr = String(result.stderr);
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
  return result.stdout;
}

function withInheritedStderr(options: SpawnOptions): SpawnOptions {
  // `execSync` shows the child's stderr unless the caller asked otherwise.
  return options.stdio === undefined ? { ...options, stdio: ["pipe", "pipe", "inherit"] } : options;
}

/** Runs a shell command line, blocking, and returns its stdout. Throws on a non-zero exit. */
export function execSync(command: string, options: SpawnOptions = {}): Buffer | string {
  const effective = withInheritedStderr(options);
  const result = runSync(command, [], { ...effective, shell: effective.shell ?? true });
  return checkSync(result, command, effective);
}

/** Runs a file with arguments, blocking, and returns its stdout. Throws on a non-zero exit. */
export function execFileSync(
  file: string,
  argsOrOptions?: readonly string[] | SpawnOptions | null,
  maybeOptions?: SpawnOptions | null,
): Buffer | string {
  const { args, options } = parseSpawnArguments(argsOrOptions, maybeOptions);
  const effective = withInheritedStderr(options);
  return checkSync(runSync(file, args, effective), [file, ...args].join(" "), effective);
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
void signalNumber;

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

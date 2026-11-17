// The `process` object: the program's view of itself — arguments, environment,
// working directory, stdio, signals, exit. It is created once per worker, after
// the process runtime is installed.
import { ARCH, EXEC_PATH, NODE_VERSION, PLATFORM, VERSIONS } from "../platform";
import { runtime } from "../runtime";
import { Buffer } from "./buffer";
import EventEmitter from "./events";
import type { EventEmitter as EventEmitterInstance } from "./events";
import { FdReadable, FdWritable } from "./internal/fdStreams";
import { BUILTIN_MODULE_NAMES, builtinName } from "./names";
import path from "./path";
import { Readable, Writable } from "./stream";
import tty from "./tty";
import { parseEnv } from "./util";
import { listenOnPlatformPort } from "./worker_threads";

// The browser's clock, captured now: a program may replace `globalThis.performance`
// with one built on `process.hrtime` (Go's WebAssembly runtime does).
const clock = globalThis.performance;

type AnyFunction = (...args: never[]) => unknown;

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGWINCH: 28,
};

/** The name for a signal given by name or number. */
export function signalName(signal: string | number | undefined): string {
  if (signal === undefined) {
    return "SIGTERM";
  }
  if (typeof signal === "number") {
    if (signal === 0) {
      return "0";
    }
    const found = Object.entries(SIGNAL_NUMBERS).find(([, number]) => number === signal);
    if (!found) {
      throw Object.assign(new TypeError(`Unknown signal: ${signal}`), {
        code: "ERR_UNKNOWN_SIGNAL",
      });
    }
    return found[0];
  }
  if (!(signal in SIGNAL_NUMBERS)) {
    throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: "ERR_UNKNOWN_SIGNAL" });
  }
  return signal;
}

/** How V8 names a value without running its code: Node's text for a rejection reason. */
function describeReason(reason: unknown): string {
  if (typeof reason === "symbol") {
    return reason.toString();
  }
  if (reason === null || (typeof reason !== "object" && typeof reason !== "function")) {
    return String(reason);
  }
  if (Array.isArray(reason)) {
    return reason
      .map((item) => (item === null || item === undefined ? "" : describeReason(item)))
      .join(",");
  }
  const constructor = (reason as { constructor?: { name?: unknown } }).constructor;
  return `#<${typeof constructor?.name === "string" && constructor.name !== "" ? constructor.name : "Object"}>`;
}

/**
 * What Node raises for a rejected promise nobody handled: the reason itself
 * when it is an error (an object with its own `stack`), otherwise an
 * `UnhandledPromiseRejection` with code ERR_UNHANDLED_REJECTION that quotes it.
 */
export function unhandledRejectionError(reason: unknown): unknown {
  if (typeof reason === "object" && reason !== null && Object.hasOwn(reason, "stack")) {
    return reason;
  }
  const error = new Error(
    `This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${describeReason(reason)}".`,
  );
  Object.assign(error, { code: "ERR_UNHANDLED_REJECTION", name: "UnhandledPromiseRejection" });
  error.stack = error.stack?.replace(/^Error/, "UnhandledPromiseRejection");
  return error;
}

/** The number of signal `name`, or 0. */
export function signalNumber(name: string): number {
  return SIGNAL_NUMBERS[name] ?? 0;
}

/** Runs this worker's queued nextTick callbacks; set by `createProcess`. */
let tickRunner: (() => void) | null = null;

/**
 * Runs the queued `process.nextTick` callbacks now. Whoever enters user code
 * from the event loop (a timer, an immediate, a kernel message) calls this as
 * the task ends, so ticks run before promise jobs, as in Node.
 */
export function runNextTicks(): void {
  tickRunner?.();
}

export interface NodeProcess extends EventEmitterInstance {
  [key: string]: unknown;
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  exitCode: number | undefined;
  pid: number;
  stdout: Writable & { isTTY?: boolean; columns?: number; fd: number };
  stderr: Writable & { isTTY?: boolean; columns?: number; fd: number };
  stdin: Readable & { isTTY?: boolean; fd: number };
  nextTick(callback: AnyFunction, ...args: unknown[]): void;
  exit(code?: number): never;
  cwd(): string;
  emitWarning(warning: string | Error, type?: unknown, code?: string): void;
}

export interface ProcessHost {
  /** The exports of a builtin module, for `process.getBuiltinModule`. */
  loadBuiltin(name: string): unknown;
  /** The IPC channel to the parent, when this process was forked. */
  ipc: MessagePort | null;
}

/** A writable for a file descriptor that is a file: each write is one blocking call. */
class FileWritable extends Writable {
  readonly fd: number;

  constructor(fd: number) {
    super({ decodeStrings: true });
    this.fd = fd;
  }

  override _write(
    chunk: Uint8Array,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      runtime().fs.write(this.fd, chunk, null);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

function createOutput(fd: number): NodeProcess["stdout"] {
  const kind = runtime().fdStream.kind(fd);
  let stream: Writable;
  if (kind === "tty") {
    stream = new tty.WriteStream(fd);
  } else if (kind === "pipe") {
    stream = new FdWritable(fd);
  } else {
    stream = new FileWritable(fd);
  }
  if (kind !== "file" && kind !== "null") {
    // As on Linux, a write to a terminal or pipe is complete when `write` returns:
    // the bytes are handed to the kernel in order, and none are lost at exit.
    (stream as { _write: Writable["_write"] })._write = (chunk, encoding, callback) => {
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk, encoding as BufferEncoding)
          : (chunk as Uint8Array);
      if (kind === "pipe") {
        // A broken pipe surfaces on the stream: Node ignores SIGPIPE, so the
        // write fails with EPIPE and the process lives.
        runtime().fdStream.write(fd, bytes, (error) => {
          if (error && !stream.destroyed) {
            stream.destroy(error);
          }
        });
      } else {
        runtime().fdStream.write(fd, bytes);
      }
      callback();
    };
  }
  // A program that ends or destroys its stdout must not take the stream down.
  const output = stream as NodeProcess["stdout"] & { destroySoon?: unknown; _destroy?: unknown };
  output._destroy = (error: Error | null, callback: (error?: Error | null) => void) =>
    callback(error);
  output.destroySoon = output.destroy;
  return output;
}

function createInput(fd: number): NodeProcess["stdin"] {
  const kind = runtime().fdStream.kind(fd);
  if (kind === "tty") {
    return new tty.ReadStream(fd) as unknown as NodeProcess["stdin"];
  }
  if (kind === "pipe") {
    return new FdReadable(fd) as unknown as NodeProcess["stdin"];
  }
  // A file: read it through in blocks.
  const stream = new Readable({
    read(size: number) {
      try {
        const chunk = runtime().fs.read(fd, size || 65536, null);
        this.push(chunk.byteLength === 0 ? null : Buffer.from(chunk));
      } catch (error) {
        this.destroy(error as Error);
      }
    },
  }) as unknown as NodeProcess["stdin"];
  (stream as { fd: number }).fd = fd;
  return stream;
}

/** Builds the process object. Call once, after `setRuntime`. */
export function createProcess(host: ProcessHost): NodeProcess {
  const rt = runtime();
  const startedAt = clock.now();
  const process = new EventEmitter() as NodeProcess;

  // nextTick: callbacks run in order as soon as the current code returns. The
  // event loop's entry points drain them synchronously (`runNextTicks`); a
  // microtask drains the ones queued from a promise job.
  const ticks: { callback: AnyFunction; args: unknown[] }[] = [];
  let scheduled = false;
  let running = false;
  const runTicks = () => {
    if (running) {
      return;
    }
    running = true;
    let index = 0;
    try {
      while (index < ticks.length) {
        const tick = ticks[index];
        index += 1;
        (tick.callback as (...args: unknown[]) => unknown)(...tick.args);
      }
    } finally {
      ticks.splice(0, index);
      running = false;
      if (ticks.length > 0 && !scheduled) {
        scheduled = true;
        queueMicrotask(drainFromMicrotask);
      }
    }
  };
  const drainFromMicrotask = () => {
    scheduled = false;
    runTicks();
  };
  tickRunner = runTicks;

  const env = new Proxy(rt.env, {
    set(target, key, value) {
      if (typeof key === "string") {
        target[key] = String(value);
      }
      return true;
    },
    defineProperty(target, key, descriptor) {
      if (typeof key === "string" && "value" in descriptor) {
        target[key] = String(descriptor.value);
      }
      return true;
    },
  });

  const hrtime = (previous?: [number, number]): [number, number] => {
    const now = clock.timeOrigin + clock.now();
    const seconds = Math.floor(now / 1000);
    const nanoseconds = Math.floor((now % 1000) * 1e6);
    if (!previous) {
      return [seconds, nanoseconds];
    }
    let deltaSeconds = seconds - previous[0];
    let deltaNanoseconds = nanoseconds - previous[1];
    if (deltaNanoseconds < 0) {
      deltaSeconds -= 1;
      deltaNanoseconds += 1e9;
    }
    return [deltaSeconds, deltaNanoseconds];
  };
  hrtime.bigint = (): bigint => BigInt(Math.floor((clock.timeOrigin + clock.now()) * 1e6));

  const memoryUsage = () => {
    const memory = (
      clock as Performance & {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
      }
    ).memory;
    const heapUsed = memory?.usedJSHeapSize ?? 0;
    const heapTotal = memory?.totalJSHeapSize ?? 0;
    return { rss: heapTotal, heapTotal, heapUsed, external: 0, arrayBuffers: 0 };
  };
  memoryUsage.rss = () => memoryUsage().rss;

  let exiting = false;
  let stdout: NodeProcess["stdout"] | undefined;
  let stderr: NodeProcess["stderr"] | undefined;
  let stdin: NodeProcess["stdin"] | undefined;
  let warningsShown = true;
  let captureCallback: ((error: unknown) => void) | null = null;
  let connected = host.ipc !== null;
  let ipcReffed = false;
  /** `process.channel.unref()` was called: a 'message' listener no longer keeps the process alive. */
  let channelUnrefed = false;
  const updateIpcRef = () => {
    const want =
      host.ipc !== null && connected && !channelUnrefed && process.listenerCount("message") > 0;
    if (want !== ipcReffed) {
      ipcReffed = want;
      if (want) {
        rt.ref();
      } else {
        rt.unref();
      }
    }
  };
  const channel = {
    ref() {
      channelUnrefed = false;
      updateIpcRef();
    },
    unref() {
      channelUnrefed = true;
      updateIpcRef();
    },
  };

  const members: Record<string, unknown> = {
    title: "node",
    version: `v${NODE_VERSION}`,
    versions: { ...VERSIONS },
    platform: PLATFORM,
    arch: ARCH,
    pid: rt.pid,
    ppid: rt.ppid,
    execPath: EXEC_PATH,
    argv0: "node",
    argv: rt.argv,
    execArgv: rt.execArgv,
    env,
    exitCode: undefined,
    release: {
      name: "node",
      lts: "Jod",
      sourceUrl: `https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.gz`,
      headersUrl: `https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-headers.tar.gz`,
    },
    config: { target_defaults: {}, variables: { napi_build_version: "10" } },
    features: {
      inspector: false,
      debug: false,
      uv: true,
      ipv6: true,
      tls_alpn: true,
      tls_sni: true,
      tls_ocsp: true,
      tls: true,
      cached_builtins: true,
      require_module: true,
      typescript: "strip",
    },
    allowedNodeEnvironmentFlags: new Set<string>(),
    noDeprecation: false,
    throwDeprecation: false,
    traceDeprecation: false,
    sourceMapsEnabled: false,
    debugPort: 9229,
    // The simulated machine a native-addon loader probes: glibc Linux.
    report: {
      getReport: () => ({
        header: { glibcVersionRuntime: "2.36", glibcVersionCompiler: "2.36" },
        sharedObjects: [],
      }),
      writeReport: () => "",
      directory: "",
      filename: "",
    },

    cwd: () => rt.cwd,
    chdir(directory: string) {
      const target = path.resolve(String(directory));
      const mode = rt.fs.stat(target, true).mode & 0o170000;
      if (mode !== 0o040000) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, chdir '${directory}'`), {
          code: "ENOTDIR",
          syscall: "chdir",
          path: directory,
        });
      }
      rt.cwd = target;
      rt.env.PWD = target;
    },
    umask: () => 0o22,
    getuid: () => 1,
    geteuid: () => 1,
    getgid: () => 1,
    getegid: () => 1,
    getgroups: () => [1],
    uptime: () => (clock.now() - startedAt) / 1000,
    hrtime,
    memoryUsage,
    cpuUsage: (previous?: { user: number; system: number }) => {
      const user = Math.floor((clock.now() - startedAt) * 1000);
      return { user: user - (previous?.user ?? 0), system: 0 };
    },
    resourceUsage: () => ({
      userCPUTime: Math.floor((clock.now() - startedAt) * 1000),
      systemCPUTime: 0,
      maxRSS: Math.floor(memoryUsage().rss / 1024),
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    }),
    constrainedMemory: () => 0,
    availableMemory: () => memoryUsage().heapTotal,
    getActiveResourcesInfo: () => [],
    _getActiveHandles: () => [],
    _getActiveRequests: () => [],
    setSourceMapsEnabled: () => {},
    setUncaughtExceptionCaptureCallback(callback: ((error: unknown) => void) | null) {
      captureCallback = callback;
    },
    hasUncaughtExceptionCaptureCallback: () => captureCallback !== null,

    nextTick(callback: AnyFunction, ...args: unknown[]) {
      if (typeof callback !== "function") {
        throw Object.assign(
          new TypeError(
            `The "callback" argument must be of type function. Received ${typeof callback}`,
          ),
          { code: "ERR_INVALID_ARG_TYPE" },
        );
      }
      ticks.push({ callback, args });
      if (!scheduled && !running) {
        scheduled = true;
        queueMicrotask(drainFromMicrotask);
      }
    },

    exit(code?: number): never {
      if (code !== undefined) {
        process.exitCode = code;
      }
      if (!exiting) {
        exiting = true;
        (process as { _exiting?: boolean })._exiting = true;
        process.emit("exit", process.exitCode ?? 0);
      }
      return rt.processes.exit(Number(process.exitCode ?? 0));
    },
    reallyExit: (code?: number) => rt.processes.exit(code ?? 0),
    abort: () => rt.processes.exit(134),
    kill(pid: number, signal?: string | number) {
      rt.processes.kill(pid, signalName(signal));
      return true;
    },

    emitWarning(
      warning: string | Error,
      typeOrOptions?: string | { type?: string; code?: string; detail?: string },
      codeArgument?: string,
    ) {
      const options = typeof typeOrOptions === "object" && typeOrOptions ? typeOrOptions : {};
      const type = typeof typeOrOptions === "string" ? typeOrOptions : (options.type ?? "Warning");
      const code = codeArgument ?? options.code;
      const error =
        warning instanceof Error
          ? warning
          : Object.assign(new Error(String(warning)), { name: type });
      if (code !== undefined) {
        (error as Error & { code?: string }).code = code;
      }
      if (error.name === "DeprecationWarning") {
        if (process.noDeprecation) {
          return;
        }
        if (process.throwDeprecation) {
          throw error;
        }
      }
      process.nextTick(() => {
        process.emit("warning", error);
        if (!warningsShown) {
          return;
        }
        const prefix = code ? `[${code}] ` : "";
        process.stderr.write(`(node:${rt.pid}) ${prefix}${error.name}: ${error.message}\n`);
      });
    },

    binding(name: string) {
      throw new Error(`No such module: ${name}`);
    },
    dlopen() {
      throw Object.assign(new Error("process.dlopen is not available in webnode"), {
        code: "ERR_DLOPEN_FAILED",
      });
    },
    getBuiltinModule(id: string) {
      const name = builtinName(String(id));
      return name ? host.loadBuiltin(name) : undefined;
    },
    loadEnvFile(file = ".env") {
      const text = new TextDecoder().decode(rt.fs.readFile(path.resolve(String(file))));
      for (const [key, value] of Object.entries(parseEnv(text))) {
        if (!(key in rt.env)) {
          rt.env[key] = String(value);
        }
      }
    },
    _rawDebug: (...args: unknown[]) => {
      rt.fs.write(2, new TextEncoder().encode(`${args.join(" ")}\n`), null);
    },

    // IPC with the parent, when forked.
    send(message: unknown, ...rest: unknown[]) {
      const callback = rest.find((item) => typeof item === "function") as
        | ((error: Error | null) => void)
        | undefined;
      if (!host.ipc || !connected) {
        const error = Object.assign(new Error("Channel closed"), {
          code: "ERR_IPC_CHANNEL_CLOSED",
        });
        if (callback) {
          process.nextTick(() => callback(error));
          return false;
        }
        throw error;
      }
      host.ipc.postMessage({ type: "message", message });
      if (callback) {
        process.nextTick(() => callback(null));
      }
      return true;
    },
    disconnect() {
      if (!host.ipc || !connected) {
        return;
      }
      connected = false;
      host.ipc.postMessage({ type: "disconnect" });
      host.ipc.close();
      updateIpcRef();
      process.nextTick(() => process.emit("disconnect"));
    },
  };

  Object.assign(process, members);
  Object.defineProperty(process, Symbol.toStringTag, { value: "process" });
  Object.defineProperty(process, "builtinModules", { value: BUILTIN_MODULE_NAMES });
  Object.defineProperties(process, {
    stdout: { configurable: true, enumerable: true, get: () => (stdout ??= createOutput(1)) },
    stderr: { configurable: true, enumerable: true, get: () => (stderr ??= createOutput(2)) },
    stdin: { configurable: true, enumerable: true, get: () => (stdin ??= createInput(0)) },
    connected: { configurable: true, enumerable: true, get: () => connected },
    channel: {
      configurable: true,
      enumerable: true,
      get: () => (host.ipc && connected ? channel : undefined),
    },
  });

  const noWarnings =
    rt.env.NODE_NO_WARNINGS === "1" ||
    rt.execArgv.includes("--no-warnings") ||
    (rt.env.NODE_OPTIONS ?? "").includes("--no-warnings");
  warningsShown = !noWarnings;

  // Signals: listening for one tells the kernel the process handles it.
  // SIGPIPE is always handled: Node ignores it at startup, so a write to a
  // closed pipe fails with EPIPE on the stream instead of ending the process.
  const handled = new Set<string>();
  const publishSignals = () => rt.processes.setHandledSignals([...handled, "SIGPIPE"]);
  const isSignalEvent = (event: unknown): event is string =>
    typeof event === "string" && event in SIGNAL_NUMBERS;
  process.on("newListener", (event: unknown) => {
    if (isSignalEvent(event) && !handled.has(event)) {
      handled.add(event);
      publishSignals();
    }
    // newListener runs before the listener is added, so this cannot count it.
    if (event === "message" && host.ipc && connected && !channelUnrefed && !ipcReffed) {
      ipcReffed = true;
      rt.ref();
    }
  });
  process.on("removeListener", (event: unknown) => {
    if (isSignalEvent(event) && process.listenerCount(event) === 0) {
      handled.delete(event);
      publishSignals();
    }
    if (event === "message") {
      updateIpcRef();
    }
  });
  rt.processes.onSignal((signal) => {
    if (process.listenerCount(signal) === 0) {
      return signal === "SIGPIPE";
    }
    process.emit(signal, signal, SIGNAL_NUMBERS[signal] ?? 0);
    return true;
  });
  publishSignals();

  if (host.ipc) {
    listenOnPlatformPort(host.ipc, (event: MessageEvent<{ type: string; message?: unknown }>) => {
      if (event.data.type === "message") {
        process.emit("message", event.data.message, undefined);
      } else if (event.data.type === "disconnect" && connected) {
        connected = false;
        updateIpcRef();
        process.emit("disconnect");
      }
    });
  }

  /**
   * Reports an error nothing caught; `origin` is "unhandledRejection" for a
   * rejected promise nobody handled. Returns false when the process should end.
   */
  (process as { _handleUncaught?: unknown })._handleUncaught = (
    error: unknown,
    origin: "uncaughtException" | "unhandledRejection" = "uncaughtException",
  ): boolean => {
    if (captureCallback) {
      captureCallback(error);
      return true;
    }
    if (process.listenerCount("uncaughtException") > 0) {
      process.emit("uncaughtException", error, origin);
      return true;
    }
    return false;
  };

  return process;
}

// The `process` object: the program's view of itself — arguments, environment,
// working directory, stdio, signals, exit. It is created once per worker, after
// the process runtime is installed.
import { createSystemError, toSystemErrorRecord } from "../../errors";
import { SIGNAL_NUMBERS } from "../../signals";
import { ARCH, EXEC_PATH, GID, NODE_VERSION, PLATFORM, UID, VERSIONS } from "../platform";
import { runtime } from "../runtime";
import { Buffer } from "./buffer";
import { postIpcDisconnect, postIpcMessage } from "./internal/ipcEnvelope";
import { Console } from "./console";
import { queueTick, startEventLoop } from "./eventLoop";
import EventEmitter from "./events";
import type { EventEmitter as EventEmitterInstance } from "./events";
import { parseFileMode } from "./fs/args";
import { checkChdir } from "./fs/chdir";
import { FdReadable, FdWritable, streamWriteError } from "./internal/fdStreams";
import { invalidArgType, makeNodeError, validateString } from "./internalErrors";
import { BUILTIN_MODULE_NAMES, builtinName } from "./names";
import { errnoException } from "./net/errors";
import { signals as nodeSignals } from "./os";
import path from "./path";
import { kernelSignalName } from "./signalNames";
import { Readable, Writable } from "./stream";
import tty from "./tty";
import { parseEnv } from "./util";
import { listenOnPlatformPort } from "./worker_threads";

// The browser's clock, captured now: a program may replace `globalThis.performance`
// with one built on `process.hrtime` (Go's WebAssembly runtime does).
const clock = globalThis.performance;

type AnyFunction = (...args: never[]) => unknown;

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

/** The flags of a Writable's state that say it has ended. */
interface EndedState {
  ending: boolean;
  ended: boolean;
  finalCalled: boolean;
  prefinished: boolean;
  finished: boolean;
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
  /**
   * `end()` shut the pipe or terminal down, as libuv shuts Node's stream
   * down: a later write fails with EPIPE and nothing reaches the reader, who
   * sees no end of file before the process exits. A file is written on.
   */
  let shutDown = false;
  if (kind !== "file" && kind !== "null") {
    const final = stream._final;
    stream._final = (callback) => {
      shutDown = true;
      final.call(stream, callback);
    };
    // Synchronous: a write is complete when `write` returns, as Node's is
    // for a terminal. For a pipe Node queues what does not fit and goes on
    // (and loses the queue at `process.exit()`); here, on purpose, the bytes
    // are handed to the kernel in order and none are lost at exit, and past
    // what a pipe holds a write waits for its reader, so a program that
    // ignores backpressure waits instead of growing. A broken pipe fails the
    // write with EPIPE (Node ignores SIGPIPE), which the write's callback
    // gets as Node's does, so `console` can keep it quiet.
    (stream as { _write: Writable["_write"] })._write = (chunk, encoding, callback) => {
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk, encoding as BufferEncoding)
          : (chunk as Uint8Array);
      if (shutDown) {
        callback(errnoException("EPIPE", "write"));
        return;
      }
      try {
        runtime().fdStream.write(fd, bytes);
      } catch (error) {
        // Where an asynchronous write's error would come, as Node's (macOS)
        // pipe writes are: after the messages the kernel sent first, so a
        // Ctrl+C that also ended the reader runs the SIGINT handler first.
        runtime().fdStream.reportWriteError(fd, streamWriteError(error as Error), callback);
        return;
      }
      callback();
    };
  }
  // A program that ends or destroys its stdout, or a write that fails, must
  // not take the stream down. As Node's dummyDestroy: the destroy is
  // reported ('error', 'close') and then undone, so the stream is writable
  // again and each later write to a broken pipe fails with its own EPIPE.
  const output = stream as NodeProcess["stdout"] & {
    destroySoon?: unknown;
    _destroy?: unknown;
    _undestroy(): void;
    _writableState: EndedState;
  };
  // Node's terminal stream is a duplex whose readable side never ends, so
  // 'finish' does not destroy it: no 'close' at end(), and the first write
  // after it fails as a write after end (later ones with EPIPE).
  let finishing = false;
  if (kind === "tty") {
    const emit = output.emit;
    output.emit = function (this: typeof output, event: string | symbol, ...args: unknown[]) {
      const listened = emit.call(this, event, ...args);
      if (event === "finish") {
        // What destroys the stream as 'finish' returns is the stream's own autoDestroy.
        finishing = true;
        queueTick(() => {
          finishing = false;
        }, []);
      }
      return listened;
    };
  }
  output._destroy = (error: Error | null, callback: (error?: Error | null) => void) => {
    if (finishing && error === null) {
      finishing = false;
      // Not destroyed after all, and still ended: nothing is reported.
      output._undestroy();
      const state = output._writableState;
      state.ending = state.ended = state.finalCalled = state.prefinished = state.finished = true;
      return;
    }
    callback(error);
    output._undestroy();
  };
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

  // nextTick: callbacks run in Node's order (eventLoop.ts), and so do the
  // reports of rejections nobody handled.
  startEventLoop();

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
    chdir(directory: unknown) {
      validateString(directory, "directory");
      if (!rt.threads.isMainThread) {
        // The working directory belongs to the process, not to one thread.
        throw makeNodeError(
          "ERR_WORKER_UNSUPPORTED_OPERATION",
          "process.chdir() is not supported in workers",
          TypeError,
        );
      }
      if (directory === "") {
        // As chdir(2): an empty path names nothing.
        throw createSystemError("ENOENT", "chdir", rt.cwd, directory);
      }
      const target = path.resolve(directory);
      // What chdir(2) checks, with Node's error: `<code>: …, chdir '<cwd>' -> '<directory>'`.
      checkChdir(directory, target);
      // The directory itself, as getcwd(2) answers: with no link on the way.
      // `env.PWD` is the shell's to keep; Node leaves it alone.
      rt.cwd = rt.fs.realpath(target);
    },
    // Node's name for it. With no argument it reads the mask; with one it
    // sets the mask and returns the one before.
    umask: function wrappedUmask(mask: unknown) {
      if (mask === undefined) {
        return rt.umask;
      }
      if (!rt.threads.isMainThread) {
        // The mask belongs to the process, not to one thread.
        throw makeNodeError(
          "ERR_WORKER_UNSUPPORTED_OPERATION",
          "Setting process.umask() is not supported in workers",
          TypeError,
        );
      }
      const next = parseFileMode(mask, "mask");
      const previous = rt.umask;
      rt.umask = next;
      return previous;
    },
    getuid: () => UID,
    geteuid: () => UID,
    getgid: () => GID,
    getegid: () => GID,
    getgroups: () => [GID],
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
      queueTick(callback, args);
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
    // A negative pid names a process group, as kill(2): `-child.pid` reaches
    // a `detached` child and everything it started.
    kill(pid: unknown, signal?: string | number) {
      if (
        (typeof pid !== "number" && typeof pid !== "string") ||
        Number(pid) !== (Number(pid) | 0)
      ) {
        throw invalidArgType("pid", "number", pid);
      }
      const name = kernelSignalName(signal);
      try {
        rt.processes.kill(Number(pid), name);
      } catch (error) {
        // Node's ErrnoException: `kill ESRCH`.
        const record = toSystemErrorRecord(error);
        throw record === null ? error : errnoException(record.code, "kill");
      }
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
      if (typeof options.detail === "string") {
        (error as Error & { detail?: string }).detail = options.detail;
      }
      if (error.name === "DeprecationWarning") {
        if (process.noDeprecation) {
          return;
        }
        if (process.throwDeprecation) {
          throw error;
        }
      }
      process.nextTick(() => process.emit("warning", error));
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
  };

  Object.assign(process, members);
  Object.defineProperty(process, Symbol.toStringTag, { value: "process" });
  Object.defineProperty(process, "builtinModules", { value: BUILTIN_MODULE_NAMES });
  Object.defineProperties(process, {
    stdout: { configurable: true, enumerable: true, get: () => (stdout ??= createOutput(1)) },
    stderr: { configurable: true, enumerable: true, get: () => (stderr ??= createOutput(2)) },
    stdin: { configurable: true, enumerable: true, get: () => (stdin ??= createInput(0)) },
  });

  // IPC with the parent. As in Node, `send`, `disconnect`, `connected` and
  // `channel` exist only in a process that was started with a channel: a
  // program tells by `if (process.send)` whether it has a parent to report to.
  const ipc = host.ipc;
  if (ipc) {
    const channelClosed = () => makeNodeError("ERR_IPC_CHANNEL_CLOSED", "Channel closed", Error);
    Object.assign(process, {
      send(message: unknown, ...rest: unknown[]) {
        const callback = rest.find((item) => typeof item === "function") as
          | ((error: Error | null) => void)
          | undefined;
        if (!connected) {
          const error = channelClosed();
          if (callback) {
            process.nextTick(() => callback(error));
          } else {
            process.nextTick(() => process.emit("error", error));
          }
          return false;
        }
        postIpcMessage(ipc, message);
        if (callback) {
          process.nextTick(() => callback(null));
        }
        return true;
      },
      disconnect() {
        if (!connected) {
          process.emit(
            "error",
            makeNodeError("ERR_IPC_DISCONNECTED", "IPC channel is already disconnected", Error),
          );
          return;
        }
        connected = false;
        postIpcDisconnect(ipc);
        ipc.close();
        updateIpcRef();
        process.nextTick(() => process.emit("disconnect"));
      },
    });
    Object.defineProperties(process, {
      connected: { configurable: true, enumerable: true, get: () => connected },
      channel: { configurable: true, enumerable: true, get: () => (connected ? channel : null) },
    });
  }

  const noWarnings =
    rt.env.NODE_NO_WARNINGS === "1" ||
    rt.execArgv.includes("--no-warnings") ||
    (rt.env.NODE_OPTIONS ?? "").includes("--no-warnings");
  if (!noWarnings) {
    // As in Node, a warning is printed by a 'warning' listener of the
    // process's own, the first one: a program's listeners run after the line
    // is written, and a program that removes every listener silences them.
    // The text is Node's: the warning, its `detail` on a line of its own,
    // and after the first one how to find where a warning came from. It goes
    // out through a console, as Node's does: a stderr that cannot be written
    // (a pipe whose reader has gone) loses the warning and the process goes on.
    let printer: Console | null = null;
    let hintShown = false;
    process.on("warning", (warning: Error & { code?: unknown; detail?: unknown }) => {
      const prefix = typeof warning.code === "string" ? `[${warning.code}] ` : "";
      let text = `(node:${rt.pid}) ${prefix}${String(warning)}`;
      if (typeof warning.detail === "string") {
        text += `\n${warning.detail}`;
      }
      if (!hintShown) {
        hintShown = true;
        const flag =
          warning.name === "DeprecationWarning" ? "--trace-deprecation" : "--trace-warnings";
        text += `\n(Use \`node ${flag} ...\` to show where the warning was created)`;
      }
      printer ??= new Console(process.stderr);
      printer.error(text);
    });
  }

  // Signals: listening for one tells the kernel the process handles it.
  // SIGPIPE is always handled: Node ignores it at startup, so a write to a
  // closed pipe fails with EPIPE on the stream instead of ending the process.
  // A listener may go by any name Node has for a signal (`os.constants.signals`:
  // SIGIOT is SIGABRT, SIGPOLL is SIGIO); the kernel knows each signal by one.
  const handled = new Set<string>();
  const publishSignals = () => rt.processes.setHandledSignals([...handled, "SIGPIPE"]);
  const isSignalEvent = (event: unknown): event is string =>
    typeof event === "string" && Object.hasOwn(nodeSignals, event);
  /** Node's names for the signal the kernel calls `signal`, in Node's order. */
  const namesOfSignal = (signal: string): string[] =>
    Object.keys(nodeSignals).filter((name) => nodeSignals[name] === SIGNAL_NUMBERS[signal]);
  process.on("newListener", (event: unknown) => {
    if (isSignalEvent(event) && !handled.has(kernelSignalName(event))) {
      handled.add(kernelSignalName(event));
      publishSignals();
    }
    // newListener runs before the listener is added, so this cannot count it.
    if (event === "message" && host.ipc && connected && !channelUnrefed && !ipcReffed) {
      ipcReffed = true;
      rt.ref();
    }
  });
  process.on("removeListener", (event: unknown) => {
    if (isSignalEvent(event)) {
      const signal = kernelSignalName(event);
      if (namesOfSignal(signal).every((name) => process.listenerCount(name) === 0)) {
        handled.delete(signal);
        publishSignals();
      }
    }
    if (event === "message") {
      updateIpcRef();
    }
  });
  rt.processes.onSignal((signal) => {
    // Each name with listeners gets the signal under that name, as each of
    // Node's signal watchers emits its own.
    const names = namesOfSignal(signal).filter((name) => process.listenerCount(name) > 0);
    for (const name of names) {
      process.emit(name, name, nodeSignals[name]);
    }
    return names.length > 0 || signal === "SIGPIPE";
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

// Makes a worker's global scope look like Node's: installs `process`, `Buffer`,
// Node's timers and console, hides the globals only a browser worker has, and
// keeps the process alive while the browser's own asynchronous work is pending.
import { NODE_VERSION } from "../platform";
import { runtime } from "../runtime";
import { Buffer } from "./buffer";
import { createConsole } from "./console";
import { dispatchFromProgram, runEventListener } from "./eventLoop";
import { isLocalWebSocketUrl, LocalWebSocket } from "./http/localWebSocket";
import { createFetch } from "./internal/localFetch";
import { validateFunction, validateInteger } from "./internalErrors";
import type { NodeProcess } from "./process";
import timers from "./timers";
import { cloneWithPorts, connectProcess, installMessagePortInterface } from "./worker_threads";

type Global = Record<string, unknown>;

/** Globals a dedicated worker has and Node does not; programs probe them to tell where they run. */
const WORKER_ONLY_GLOBALS = [
  "self",
  "importScripts",
  "WorkerGlobalScope",
  "DedicatedWorkerGlobalScope",
  "WorkerNavigator",
  "WorkerLocation",
  "location",
  "postMessage",
  "onmessage",
  "onmessageerror",
  "close",
  "name",
  "Worker",
  "SharedWorker",
  "XMLHttpRequest",
  "FileReaderSync",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

// The platform's own, captured now: the globals below call them.
const platformQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
const platformStructuredClone = globalThis.structuredClone.bind(globalThis);
const platformPerformance = globalThis.performance;
const platformCrypto = globalThis.crypto;

/**
 * Removes `name` from the global object and from the prototypes of the
 * worker's global scope (where a browser keeps most of its globals), so that
 * the name is not there at all. False when one of them will not let it go.
 */
function removeGlobal(global: object, name: string): boolean {
  for (
    let owner: object | null = global;
    owner !== null && owner !== EventTarget.prototype && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner) as object | null
  ) {
    if (Object.prototype.hasOwnProperty.call(owner, name) && !Reflect.deleteProperty(owner, name)) {
      return false;
    }
  }
  return true;
}

/** `queueMicrotask(callback)`, with Node's error for what is not a function. */
function queueMicrotask(callback: () => void): void {
  validateFunction(callback, "callback");
  platformQueueMicrotask(callback);
}

/**
 * `structuredClone(value[, options])`: as Node does, a closed port in the
 * transfer list is refused, and a port that holds messages keeps them.
 */
function structuredClone(value: unknown, options?: StructuredSerializeOptions): unknown {
  return cloneWithPorts(platformStructuredClone, value, options);
}

/**
 * Makes `queueMicrotask`, `structuredClone`, `performance` and `crypto`
 * properties of the global object itself, as they are in Node (a worker has
 * them on its prototype chain). Libraries that fake the timing globals,
 * @sinonjs/fake-timers among them, only replace the ones the global object
 * owns. Deleting `structuredClone` or `crypto` leaves nothing behind, as in Node.
 */
export function installOwnGlobals(global: Record<string, unknown>): void {
  removeGlobal(global, "structuredClone");
  for (const [name, value] of [
    ["queueMicrotask", queueMicrotask],
    ["structuredClone", structuredClone],
  ] as const) {
    Object.defineProperty(global, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  Object.defineProperty(global, "performance", {
    configurable: true,
    enumerable: true,
    get: () => platformPerformance,
    set(value: unknown) {
      Object.defineProperty(global, "performance", {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
  });
  if (platformCrypto !== undefined) {
    // An accessor with no setter, as Node's.
    removeGlobal(global, "crypto");
    Object.defineProperty(global, "crypto", {
      configurable: true,
      enumerable: true,
      get: () => platformCrypto,
    });
  }
}

/**
 * Takes the globals only a browser worker has off `global`, so that a program
 * finds them as it would in Node: not there at all (`name in globalThis` is
 * false), or undefined where the browser keeps the name.
 */
export function hideWorkerOnlyGlobals(global: object): void {
  for (const name of WORKER_ONLY_GLOBALS) {
    if (removeGlobal(global, name)) {
      continue;
    }
    // A scope that keeps the name: it reads as undefined at least.
    try {
      Object.defineProperty(global, name, {
        value: undefined,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // A browser that will not let the name be shadowed keeps it.
    }
  }
}

/** Holds a ref on the process until `promise` settles. */
function keepAlive<T>(promise: Promise<T>): Promise<T> {
  let rt;
  try {
    rt = runtime();
  } catch {
    return promise;
  }
  rt.ref();
  const release = () => rt.unref();
  promise.then(release, release);
  return promise;
}

function wrapAsyncMethods(target: object | undefined, names: string[]): void {
  if (!target) {
    return;
  }
  const record = target as Record<string, unknown>;
  for (const name of names) {
    const original = record[name];
    if (typeof original !== "function") {
      continue;
    }
    record[name] = function (this: unknown, ...args: unknown[]) {
      const result = (original as (...args: unknown[]) => unknown).apply(this, args);
      return result instanceof Promise ? keepAlive(result) : result;
    };
  }
}

/**
 * Makes iterating or piping a stream made from `prototype` hold the process
 * open: `for await`, `values()`, `pipeTo` and `pipeThrough` read through the
 * stream's internals, not through the patched `reader.read`.
 */
export function keepAliveWhileStreaming(prototype: ReadableStream | undefined): void {
  if (!prototype) {
    return;
  }
  const record = prototype as unknown as Record<PropertyKey, unknown>;
  for (const name of [Symbol.asyncIterator, "values"] as const) {
    const original = record[name];
    if (typeof original !== "function") {
      continue;
    }
    record[name] = function (this: ReadableStream, ...args: unknown[]) {
      const iterator = (original as (...args: unknown[]) => AsyncIterator<unknown>).apply(
        this,
        args,
      );
      const nativeNext = iterator.next;
      const nativeReturn = iterator.return;
      iterator.next = (...nextArgs: [] | [unknown]) =>
        keepAlive(nativeNext.apply(iterator, nextArgs));
      if (nativeReturn) {
        iterator.return = (value?: unknown) => keepAlive(nativeReturn.call(iterator, value));
      }
      return iterator;
    };
  }
  const nativePipeTo = record.pipeTo;
  if (typeof nativePipeTo === "function") {
    const pipeTo = function (this: ReadableStream, ...args: unknown[]) {
      return keepAlive((nativePipeTo as (...args: unknown[]) => Promise<void>).apply(this, args));
    };
    record.pipeTo = pipeTo;
    if (typeof record.pipeThrough === "function") {
      // pipeThrough as the spec defines it, over the pipeTo that holds a ref.
      record.pipeThrough = function (
        this: ReadableStream,
        transform: ReadableWritablePair<unknown, unknown>,
        options?: StreamPipeOptions,
      ) {
        if (this.locked) {
          throw new TypeError("ReadableStream.pipeThrough: the stream is locked");
        }
        if (transform.writable.locked) {
          throw new TypeError("ReadableStream.pipeThrough: the writable side is locked");
        }
        pipeTo.call(this, transform.writable, options).catch(() => {});
        return transform.readable;
      };
    }
  }
}

/** The listener the platform is given for a program's listener: one per listener, so removal finds it. */
const macrotaskListeners = new WeakMap<object, EventListener>();
/** Sockets whose `close()` the program called: the browser gives those no more messages. */
const closedByProgram = new WeakSet<object>();
/** The listeners a program added to each socket, by event type. */
const addedListeners = new WeakMap<object, Map<string, Set<unknown>>>();
/** The `on<event>` handlers a program set on each socket, by property name. */
const handlerValues = new WeakMap<object, Map<string, unknown>>();

function setAdded(target: object, type: string, listener: unknown, added: boolean): void {
  let types = addedListeners.get(target);
  if (types === undefined) {
    types = new Map();
    addedListeners.set(target, types);
  }
  const listeners = types.get(type) ?? new Set();
  types.set(type, listeners);
  if (added) {
    listeners.add(listener);
  } else {
    listeners.delete(listener);
  }
}

/**
 * Whether the program still listens with `listener` to `event` on `socket`,
 * for a call that came later than its event, after ticks that were waiting
 * (eventLoop.ts `runMacrotask`): not to a listener those removed, nor with a
 * message for a socket they closed, which the browser would not have
 * delivered either. A socket its peer closed still gets the messages that
 * came before the close: its 'close' event waits behind them.
 */
function stillListening(socket: object, event: Event, listener: unknown): boolean {
  if (event.type === "message" && closedByProgram.has(socket)) {
    return false;
  }
  return (
    addedListeners.get(socket)?.get(event.type)?.has(listener) === true ||
    handlerValues.get(socket)?.get(`on${event.type}`) === listener
  );
}

/**
 * `listener` as a listener whose call, for an event the platform dispatched,
 * is a macrotask (eventLoop.ts `runEventListener`).
 */
function macrotaskListener(listener: EventListenerOrEventListenerObject): EventListener {
  let wrapped = macrotaskListeners.get(listener);
  if (wrapped === undefined) {
    wrapped = function (this: object, event: Event) {
      let now = true;
      runEventListener(() => {
        if (!now && !stillListening(this, event, listener)) {
          return;
        }
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      });
      now = false;
    };
    macrotaskListeners.set(listener, wrapped);
  }
  return wrapped;
}

/** The `on<event>` handler properties of a WebSocket. */
const WEB_SOCKET_HANDLERS = ["onopen", "onmessage", "onerror", "onclose"];

/**
 * Makes `prototype`'s `on<event>` handlers (found on `native`'s chain) run as
 * macrotasks, while reading back as the handler the program set.
 */
function macrotaskHandlerProperties(prototype: object, native: object, names: string[]): void {
  for (const name of names) {
    let owner: object | null = native;
    let descriptor: PropertyDescriptor | undefined;
    while (owner !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    const { get, set } = descriptor ?? {};
    if (get === undefined || set === undefined) {
      continue;
    }
    Object.defineProperty(prototype, name, {
      configurable: true,
      enumerable: descriptor?.enumerable,
      get(this: object) {
        const own = handlerValues.get(this);
        return own?.has(name) ? own.get(name) : get.call(this);
      },
      set(this: object, value: unknown) {
        let own = handlerValues.get(this);
        if (own === undefined) {
          own = new Map();
          handlerValues.set(this, own);
        }
        own.set(name, value);
        set.call(
          this,
          typeof value === "function" ? macrotaskListener(value as EventListener) : value,
        );
      },
    });
  }
}

/**
 * A `WebSocket` that keeps the process alive from construction until it
 * closes, as Node's does; the native one does not count as pending work. Its
 * events are macrotasks, as a socket's are in Node.
 */
export function createRefedWebSocket(Native: typeof WebSocket): typeof WebSocket {
  const Refed = class WebSocket extends Native {
    // A socket to a local host reaches the server inside the runtime; the
    // native one would dial the visitor's own machine.
    static [Symbol.hasInstance](value: unknown): boolean {
      return (
        value instanceof LocalWebSocket || Function.prototype[Symbol.hasInstance].call(this, value)
      );
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      if (isLocalWebSocketUrl(url)) {
        return new LocalWebSocket(url, protocols) as unknown as WebSocket;
      }
      super(url, protocols);
      let rt: ReturnType<typeof runtime>;
      try {
        rt = runtime();
      } catch {
        return;
      }
      rt.ref();
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          rt.unref();
        }
      };
      // A failed connection fires 'error' and then 'close', so 'close' always ends the hold.
      super.addEventListener("close", release);
    }

    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener !== null) {
        setAdded(this, type, listener, true);
        super.addEventListener(type, macrotaskListener(listener), options);
      }
    }

    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (listener !== null) {
        setAdded(this, type, listener, false);
        super.removeEventListener(type, macrotaskListeners.get(listener) ?? listener, options);
      }
    }

    // A program's own dispatchEvent runs the listeners as part of its caller.
    override dispatchEvent(event: Event): boolean {
      return dispatchFromProgram(() => super.dispatchEvent(event));
    }

    override close(code?: number, reason?: string): void {
      super.close(code, reason);
      closedByProgram.add(this);
    }
  };
  macrotaskHandlerProperties(Refed.prototype, Native.prototype, WEB_SOCKET_HANDLERS);
  return Refed;
}

/**
 * The browser's promise-returning APIs do not count as pending work the way
 * Node's I/O does, so each call holds the process open until it settles.
 */
function keepAliveDuringNativeWork(global: Global): void {
  const nativeFetch = global.fetch as typeof fetch | undefined;
  if (nativeFetch) {
    global.fetch = createFetch((...args: Parameters<typeof fetch>) =>
      keepAlive(nativeFetch(...args)),
    );
  }
  wrapAsyncMethods(globalThis.WebAssembly, [
    "compile",
    "instantiate",
    "compileStreaming",
    "instantiateStreaming",
  ]);
  wrapAsyncMethods(globalThis.crypto?.subtle && Object.getPrototypeOf(globalThis.crypto.subtle), [
    "digest",
    "encrypt",
    "decrypt",
    "sign",
    "verify",
    "generateKey",
    "deriveKey",
    "deriveBits",
    "importKey",
    "exportKey",
    "wrapKey",
    "unwrapKey",
  ]);
  const bodyReaders = ["text", "json", "arrayBuffer", "blob", "formData", "bytes"];
  wrapAsyncMethods(globalThis.Response?.prototype, bodyReaders);
  wrapAsyncMethods(globalThis.Request?.prototype, bodyReaders);
  wrapAsyncMethods(globalThis.Blob?.prototype, ["text", "arrayBuffer", "bytes"]);
  wrapAsyncMethods(globalThis.ReadableStreamDefaultReader?.prototype, ["read"]);
  wrapAsyncMethods(globalThis.WritableStreamDefaultWriter?.prototype, ["write", "close"]);
  keepAliveWhileStreaming(globalThis.ReadableStream?.prototype);
  const NativeWebSocket = global.WebSocket as typeof WebSocket | undefined;
  if (typeof NativeWebSocket === "function") {
    global.WebSocket = createRefedWebSocket(NativeWebSocket);
  }
}

/**
 * `AbortSignal.timeout` on Node's timers, as Node has it: the signal aborts
 * from a timer, a macrotask (the ticks its listeners queue run before their
 * promise jobs), and the timer does not keep the process alive.
 */
export function installAbortSignalTimeout(): void {
  const Signal = globalThis.AbortSignal as typeof AbortSignal | undefined;
  if (typeof Signal?.timeout !== "function") {
    return;
  }
  Object.defineProperty(Signal, "timeout", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function timeout(delay: unknown): AbortSignal {
      validateInteger(delay, "delay", 0, 2 ** 32 - 1);
      const controller = new AbortController();
      timers
        .setTimeout(() => {
          controller.abort(
            new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          );
        }, delay)
        .unref();
      return controller.signal;
    },
  });
}

/** Installs Node's globals for `process` in this worker. */
export function installGlobals(process: NodeProcess): Console {
  const global = globalThis as unknown as Global;
  const nativeConsole = globalThis.console;

  hideWorkerOnlyGlobals(global);

  const navigator = globalThis.navigator;
  Object.defineProperty(global, "navigator", {
    configurable: true,
    writable: true,
    value: {
      hardwareConcurrency: navigator?.hardwareConcurrency ?? 1,
      language: navigator?.language ?? "en-US",
      languages: navigator?.languages ?? ["en-US"],
      platform: "linux",
      userAgent: `Node.js/${NODE_VERSION.split(".")[0]}`,
    },
  });

  installMessagePortInterface();
  connectProcess(process);
  keepAliveDuringNativeWork(global);
  installOwnGlobals(global);

  global.global = globalThis;
  global.process = process;
  global.Buffer = Buffer;
  global.setTimeout = timers.setTimeout;
  global.setInterval = timers.setInterval;
  global.setImmediate = timers.setImmediate;
  global.clearTimeout = timers.clearTimeout;
  global.clearInterval = timers.clearInterval;
  global.clearImmediate = timers.clearImmediate;
  installAbortSignalTimeout();

  const errorConstructor = Error as ErrorConstructor & {
    captureStackTrace?: (target: object) => void;
  };
  errorConstructor.captureStackTrace ??= (target: object) => {
    (target as { stack?: string }).stack = new Error().stack;
  };

  global.console = processConsole(process);
  return nativeConsole;
}

/**
 * The global `console` of `process`. It takes `process.stdout` and
 * `process.stderr` on its first write, as Node's binds them lazily, and writes
 * to them as Node's console does: a write that fails (EPIPE once a pipe's
 * reader has gone) never reaches the program.
 */
export function processConsole(process: NodeProcess): ReturnType<typeof createConsole> {
  return createConsole(
    () => process.stdout,
    () => process.stderr,
  );
}

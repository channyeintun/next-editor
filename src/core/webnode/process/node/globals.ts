// Makes a worker's global scope look like Node's: installs `process`, `Buffer`,
// Node's timers and console, hides the globals only a browser worker has, and
// keeps the process alive while the browser's own asynchronous work is pending.
import { NODE_VERSION } from "../platform";
import { runtime } from "../runtime";
import { Buffer } from "./buffer";
import { createConsole } from "./console";
import { isLocalWebSocketUrl, LocalWebSocket } from "./http/localWebSocket";
import { createFetch } from "./internal/localFetch";
import type { NodeProcess } from "./process";
import timers from "./timers";
import { installMessagePortInterface } from "./worker_threads";

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
];

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

/**
 * A `WebSocket` that keeps the process alive from construction until it
 * closes, as Node's does; the native one does not count as pending work.
 */
export function createRefedWebSocket(Native: typeof WebSocket): typeof WebSocket {
  return class WebSocket extends Native {
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
      this.addEventListener("close", release);
    }
  };
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

function lazyStream(read: () => NodeProcess["stdout"]) {
  return {
    write: (chunk: string) => read().write(chunk),
    get isTTY() {
      return read().isTTY === true;
    },
    getColorDepth: () =>
      (read() as unknown as { getColorDepth?: () => number }).getColorDepth?.() ?? 1,
  };
}

/** Installs Node's globals for `process` in this worker. */
export function installGlobals(process: NodeProcess): Console {
  const global = globalThis as unknown as Global;
  const nativeConsole = globalThis.console;

  for (const name of WORKER_ONLY_GLOBALS) {
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
  keepAliveDuringNativeWork(global);

  global.global = globalThis;
  global.process = process;
  global.Buffer = Buffer;
  global.setTimeout = timers.setTimeout;
  global.setInterval = timers.setInterval;
  global.setImmediate = timers.setImmediate;
  global.clearTimeout = timers.clearTimeout;
  global.clearInterval = timers.clearInterval;
  global.clearImmediate = timers.clearImmediate;

  const errorConstructor = Error as ErrorConstructor & {
    captureStackTrace?: (target: object) => void;
  };
  errorConstructor.captureStackTrace ??= (target: object) => {
    (target as { stack?: string }).stack = new Error().stack;
  };

  const console = createConsole(
    lazyStream(() => process.stdout),
    lazyStream(() => process.stderr),
  );
  global.console = console;
  return nativeConsole;
}

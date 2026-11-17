// The `async_hooks` builtin: `AsyncLocalStorage`, `AsyncResource`, and the
// hook API's surface. It also owns the async-context propagation the rest of
// the runtime uses: `bindToCurrentContext(fn)` captures the current store map
// and restores it around `fn`, and `timers` and the lead's `process.nextTick`
// and I/O callbacks wrap their continuations with it.
//
// A browser has no async-context tracking, so the context travels only through
// the continuations the runtime controls: `Promise.prototype.then` (and with it
// `catch` and `finally`, which call `then`), `queueMicrotask`, webnode's timers
// and immediates, and anything wrapped with `bindToCurrentContext`. Those
// wrappers are installed lazily, when the first `AsyncLocalStorage` is
// constructed, so a program that never uses one pays nothing.
//
// Known gap: the continuation after `await` on a native promise inside a native
// async function is resumed by the engine without calling `then`, so it cannot
// be intercepted. A store set by `run()` is visible synchronously and through
// the wrapped callbacks above, but may be lost (or show an outer store) after
// such an `await`. For the same reason a store set by `enterWith()` outside
// any wrapped callback (after such an `await`, say) lasts only until the
// current synchronous run ends: past that, nothing could tell which code it
// belongs to, and it would show up in other, unrelated code.
import { invalidArgType, makeNodeError, validateFunction, validateString } from "./internalErrors";

type AnyFunction = (...args: never[]) => unknown;
type Frame = ReadonlyMap<AsyncLocalStorage<unknown>, unknown> | null;

/** The store map of the code running now; null when no store is set. */
let currentFrame: Frame = null;
/** True once an `AsyncLocalStorage` exists: before that, binding is the identity. */
let tracking = false;
/** How many frame-setting wrappers are running; 0 in unwrapped code. */
let wrapperDepth = 0;
/** The frame to go back to when the current synchronous run ends (see `enterWith`). */
let frameAfterRun: { frame: Frame } | null = null;
// Captured now: installPropagation replaces the global with a binding one.
const nativeQueueMicrotask: ((callback: VoidFunction) => void) | undefined =
  typeof globalThis.queueMicrotask === "function"
    ? globalThis.queueMicrotask.bind(globalThis)
    : undefined;

/** Runs `fn` with `frame` as the current context, restoring the previous one after. */
function runInFrame<R>(frame: Frame, fn: () => R): R {
  const previous = currentFrame;
  currentFrame = frame;
  wrapperDepth++;
  try {
    return fn();
  } finally {
    wrapperDepth--;
    currentFrame = previous;
  }
}

function bindFrame<T extends AnyFunction>(frame: Frame, fn: T): T {
  const bound = function (this: unknown, ...args: unknown[]): unknown {
    const previous = currentFrame;
    currentFrame = frame;
    wrapperDepth++;
    try {
      return (fn as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } finally {
      wrapperDepth--;
      currentFrame = previous;
    }
  };
  return bound as unknown as T;
}

/**
 * Sets the current frame for the rest of the synchronous run. Inside a wrapper
 * the wrapper restores the previous frame when it returns. Outside one (top
 * level, or after a native `await`) nothing would, so the previous frame comes
 * back on the next microtask: by then the run is over.
 */
function enterFrame(frame: Frame): void {
  if (wrapperDepth === 0 && frameAfterRun === null && nativeQueueMicrotask) {
    const pending = { frame: currentFrame };
    frameAfterRun = pending;
    nativeQueueMicrotask(() => {
      if (frameAfterRun === pending) {
        frameAfterRun = null;
        currentFrame = pending.frame;
      }
    });
  }
  currentFrame = frame;
}

/**
 * Wraps `fn` so it runs in the async context current now. Returns `fn` itself
 * until the first `AsyncLocalStorage` is constructed. The lead wraps
 * `process.nextTick` and I/O callbacks with this.
 */
export function bindToCurrentContext<T extends AnyFunction>(fn: T): T {
  if (!tracking || typeof fn !== "function") {
    return fn;
  }
  return bindFrame(currentFrame, fn);
}

/** Captures the async context current now; the returned function binds callbacks to it. */
export function captureAsyncContext(): <T extends AnyFunction>(fn: T) => T {
  const frame = currentFrame;
  return <T extends AnyFunction>(fn: T): T =>
    tracking && typeof fn === "function" ? bindFrame(frame, fn) : fn;
}

function installPropagation(): void {
  if (tracking) {
    return;
  }
  tracking = true;
  const nativeThen = Promise.prototype.then;
  // `catch` and `finally` invoke `this.then`, so wrapping `then` covers them.
  const then = function then(
    this: Promise<unknown>,
    onFulfilled?: unknown,
    onRejected?: unknown,
  ): Promise<unknown> {
    const wrap = (handler: unknown): undefined =>
      (typeof handler === "function"
        ? bindToCurrentContext(handler as AnyFunction)
        : handler) as undefined;
    return nativeThen.call(this, wrap(onFulfilled), wrap(onRejected));
  };
  // eslint-disable-next-line unicorn/no-thenable -- replacing Promise's own then is the point
  Object.defineProperty(Promise.prototype, "then", {
    value: then,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  const nativeQueueMicrotask = globalThis.queueMicrotask;
  if (typeof nativeQueueMicrotask === "function") {
    const queueMicrotask = function queueMicrotask(callback: VoidFunction): void {
      if (typeof callback !== "function") {
        throw invalidArgType("callback", "Function", callback);
      }
      nativeQueueMicrotask(bindToCurrentContext(callback));
    };
    Object.defineProperty(globalThis, "queueMicrotask", {
      value: queueMicrotask,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

/** `AsyncLocalStorage` constructor options. */
export interface AsyncLocalStorageOptions {
  name?: string;
}

/** `async_hooks.AsyncLocalStorage`: a store that follows the code's async continuations. */
export class AsyncLocalStorage<T = unknown> {
  readonly name: string;
  #enabled = false;

  constructor(options: AsyncLocalStorageOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "Object", options);
    }
    if (options.name !== undefined) {
      validateString(options.name, "options.name");
    }
    this.name = options.name ?? "";
    installPropagation();
  }

  /** A function that runs `fn` in the async context current when `bind` was called. */
  static bind<F extends AnyFunction>(fn: F): F {
    return AsyncResource.bind(fn);
  }

  /** Captures the current context: the result runs a function in it. */
  static snapshot(): <R, A extends unknown[]>(fn: (...args: A) => R, ...args: A) => R {
    const frame = currentFrame;
    return function runInAsyncScope<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R {
      return runInFrame(frame, () => fn(...args));
    };
  }

  /** The store of the current context, or undefined. */
  getStore(): T | undefined {
    if (!this.#enabled || currentFrame === null) {
      return undefined;
    }
    return currentFrame.get(this as AsyncLocalStorage<unknown>) as T | undefined;
  }

  /** Runs `callback(...args)` with `store` as this storage's store. */
  run<R, A extends unknown[]>(store: T, callback: (...args: A) => R, ...args: A): R {
    this.#enabled = true;
    const next = new Map(currentFrame ?? undefined);
    next.set(this as AsyncLocalStorage<unknown>, store);
    return runInFrame(next, () => callback(...args));
  }

  /** Runs `callback(...args)` with no store for this storage. */
  exit<R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R {
    if (currentFrame === null || !currentFrame.has(this as AsyncLocalStorage<unknown>)) {
      return callback(...args);
    }
    const next = new Map(currentFrame);
    next.delete(this as AsyncLocalStorage<unknown>);
    return runInFrame(next.size === 0 ? null : next, () => callback(...args));
  }

  /** Sets `store` for the rest of the current synchronous execution and its continuations. */
  enterWith(store: T): void {
    this.#enabled = true;
    const next = new Map(currentFrame ?? undefined);
    next.set(this as AsyncLocalStorage<unknown>, store);
    enterFrame(next);
  }

  /** Stops this storage: `getStore()` returns undefined until the next `run`/`enterWith`. */
  disable(): void {
    if (!this.#enabled) {
      return;
    }
    this.#enabled = false;
    if (currentFrame !== null && currentFrame.has(this as AsyncLocalStorage<unknown>)) {
      const next = new Map(currentFrame);
      next.delete(this as AsyncLocalStorage<unknown>);
      currentFrame = next.size === 0 ? null : next;
    }
  }
}

// Async ids. Node numbers every async resource; webnode numbers the ones made
// through `AsyncResource`. The top level of the main script is 1 (trigger 0),
// as in Node; inside `runInAsyncScope` the ids are the resource's own.
let nextAsyncId = 2;
let currentAsyncId = 1;
let currentTriggerId = 0;
const topLevelResource = {};
let currentResource: object = topLevelResource;

/** `AsyncResource` constructor options. */
export interface AsyncResourceOptions {
  triggerAsyncId?: number;
  requireManualDestroy?: boolean;
}

/** `async_hooks.AsyncResource`: runs callbacks in the context it was created in. */
export class AsyncResource {
  #frame: Frame;
  #asyncId: number;
  #triggerAsyncId: number;

  constructor(type: string, options: AsyncResourceOptions | number = {}) {
    validateString(type, "type");
    let triggerId: number | undefined;
    if (typeof options === "number") {
      triggerId = options;
    } else if (options !== null && typeof options === "object") {
      triggerId = options.triggerAsyncId;
    }
    if (triggerId === undefined) {
      triggerId = currentAsyncId;
    }
    if (!Number.isSafeInteger(triggerId) || triggerId < -1) {
      throw makeNodeError(
        "ERR_INVALID_ASYNC_ID",
        `Invalid triggerAsyncId value: ${String(triggerId)}`,
        RangeError,
      );
    }
    this.#frame = currentFrame;
    this.#asyncId = nextAsyncId++;
    this.#triggerAsyncId = triggerId;
  }

  /** A function that runs `fn` in an `AsyncResource` of `type` created now. */
  static bind<F extends AnyFunction>(fn: F, type?: string, thisArg?: unknown): F {
    const name = type ?? (fn.name || "bound-anonymous-fn");
    return new AsyncResource(name).bind(fn, thisArg);
  }

  /** Calls `fn` with `thisArg` and `args` in this resource's context. */
  runInAsyncScope<R>(fn: (...args: never[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    const previousId = currentAsyncId;
    const previousTrigger = currentTriggerId;
    const previousResource = currentResource;
    currentAsyncId = this.#asyncId;
    currentTriggerId = this.#triggerAsyncId;
    // eslint-disable-next-line typescript/no-this-alias -- the resource is the current one while it runs
    currentResource = this;
    try {
      return runInFrame(this.#frame, () =>
        (fn as unknown as (...a: unknown[]) => R).apply(thisArg, args),
      );
    } finally {
      currentAsyncId = previousId;
      currentTriggerId = previousTrigger;
      currentResource = previousResource;
    }
  }

  /** `fn` bound to this resource (and to `thisArg` when given). */
  bind<F extends AnyFunction>(fn: F, thisArg?: unknown): F {
    validateFunction(fn, "fn");
    const run = (self: unknown, args: unknown[]): unknown =>
      this.runInAsyncScope(fn, self, ...args);
    const bound =
      thisArg === undefined
        ? function (this: unknown, ...args: unknown[]): unknown {
            return run(this, args);
          }
        : (...args: unknown[]): unknown => run(thisArg, args);
    Object.defineProperties(bound, {
      length: { configurable: true, enumerable: false, value: fn.length, writable: false },
      asyncResource: { configurable: true, enumerable: true, value: this, writable: true },
    });
    return bound as unknown as F;
  }

  /** No destroy hooks can run in webnode; returns this as Node does. */
  emitDestroy(): this {
    return this;
  }

  asyncId(): number {
    return this.#asyncId;
  }

  triggerAsyncId(): number {
    return this.#triggerAsyncId;
  }
}

/** The callbacks `createHook` accepts. */
export interface HookCallbacks {
  init?: AnyFunction;
  before?: AnyFunction;
  after?: AnyFunction;
  destroy?: AnyFunction;
  promiseResolve?: AnyFunction;
}

/** What `createHook` returns. */
export interface AsyncHook {
  enable(): AsyncHook;
  disable(): AsyncHook;
}

/**
 * `async_hooks.createHook`: validates the callbacks like Node and returns a hook
 * whose `enable`/`disable` do nothing. Hooks observe the engine's async
 * machinery (promises, handles, requests), which a browser does not expose, so
 * the callbacks never run. A documented exception to "throw what the browser
 * cannot do": the users are diagnostics (why-is-node-running, cls-hooked style
 * tracing), which keep running without the events.
 */
export function createHook(callbacks: HookCallbacks): AsyncHook {
  if (callbacks === null || typeof callbacks !== "object") {
    throw invalidArgType("hooks", "Object", callbacks);
  }
  for (const name of ["init", "before", "after", "destroy", "promiseResolve"] as const) {
    const value = callbacks[name];
    if (value !== undefined && typeof value !== "function") {
      throw makeNodeError("ERR_ASYNC_CALLBACK", `hook.${name} must be a function`, TypeError);
    }
  }
  const hook: AsyncHook = {
    enable: () => hook,
    disable: () => hook,
  };
  return hook;
}

/** The id of the current execution context (1 at the top level). */
export function executionAsyncId(): number {
  return currentAsyncId;
}

/** The id of the context that caused the current one (0 at the top level). */
export function triggerAsyncId(): number {
  return currentTriggerId;
}

/** The resource of the current execution context: an `AsyncResource` or a top-level object. */
export function executionAsyncResource(): object {
  return currentResource;
}

const PROVIDER_NAMES = [
  "NONE",
  "DIRHANDLE",
  "DNSCHANNEL",
  "ELDHISTOGRAM",
  "FILEHANDLE",
  "FILEHANDLECLOSEREQ",
  "BLOBREADER",
  "FSEVENTWRAP",
  "FSREQCALLBACK",
  "FSREQPROMISE",
  "GETADDRINFOREQWRAP",
  "GETNAMEINFOREQWRAP",
  "HEAPSNAPSHOT",
  "HTTP2SESSION",
  "HTTP2STREAM",
  "HTTP2PING",
  "HTTP2SETTINGS",
  "HTTPINCOMINGMESSAGE",
  "HTTPCLIENTREQUEST",
  "JSSTREAM",
  "JSUDPWRAP",
  "MESSAGEPORT",
  "PIPECONNECTWRAP",
  "PIPESERVERWRAP",
  "PIPEWRAP",
  "PROCESSWRAP",
  "PROMISE",
  "QUERYWRAP",
  "QUIC_ENDPOINT",
  "QUIC_LOGSTREAM",
  "QUIC_PACKET",
  "QUIC_SESSION",
  "QUIC_STREAM",
  "QUIC_UDP",
  "SHUTDOWNWRAP",
  "SIGNALWRAP",
  "STATWATCHER",
  "STREAMPIPE",
  "TCPCONNECTWRAP",
  "TCPSERVERWRAP",
  "TCPWRAP",
  "TTYWRAP",
  "UDPSENDWRAP",
  "UDPWRAP",
  "SIGINTWATCHDOG",
  "WORKER",
  "WORKERHEAPSNAPSHOT",
  "WRITEWRAP",
  "ZLIB",
  "CHECKPRIMEREQUEST",
  "PBKDF2REQUEST",
  "KEYPAIRGENREQUEST",
  "KEYGENREQUEST",
  "KEYEXPORTREQUEST",
  "CIPHERREQUEST",
  "DERIVEBITSREQUEST",
  "HASHREQUEST",
  "RANDOMBYTESREQUEST",
  "RANDOMPRIMEREQUEST",
  "SCRYPTREQUEST",
  "SIGNREQUEST",
  "TLSWRAP",
  "VERIFYREQUEST",
];

/** `async_hooks.asyncWrapProviders`: Node 22's provider types, frozen with a null prototype. */
export const asyncWrapProviders: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, number>,
    Object.fromEntries(PROVIDER_NAMES.map((name, index) => [name, index])),
  ),
);

const asyncHooks = {
  AsyncLocalStorage,
  createHook,
  executionAsyncId,
  triggerAsyncId,
  executionAsyncResource,
  asyncWrapProviders,
  AsyncResource,
};

export default asyncHooks;

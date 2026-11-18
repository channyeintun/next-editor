// The `events` builtin: Node's EventEmitter, ported from lib/events.js (Node
// 22, MIT). `EventEmitter` is an old-style constructor function so packages can
// call `EventEmitter.call(this)` and `util.inherits` from it, and ES classes can
// extend it. Also the statics: `once`, `on`, `getEventListeners`,
// `setMaxListeners`, `addAbortListener`, `EventEmitterAsyncResource`, ...
import {
  AbortError,
  inspectValue,
  invalidArgType,
  makeNodeError,
  validateAbortSignal,
  validateBoolean,
  validateFunction,
  validateInteger,
  validateNumber,
  validateObject,
  validateString,
} from "./internalErrors";

/** Any listener. Listeners take whatever the emitter passes. */
// eslint-disable-next-line typescript/no-explicit-any
export type Listener = (...args: any[]) => unknown;

/** `new EventEmitter(options)`. */
export interface EventEmitterOptions {
  captureRejections?: boolean;
}

/** An EventEmitter instance. */
interface EventEmitter {
  addListener(eventName: string | symbol, listener: Listener): this;
  on(eventName: string | symbol, listener: Listener): this;
  prependListener(eventName: string | symbol, listener: Listener): this;
  once(eventName: string | symbol, listener: Listener): this;
  prependOnceListener(eventName: string | symbol, listener: Listener): this;
  removeListener(eventName: string | symbol, listener: Listener): this;
  off(eventName: string | symbol, listener: Listener): this;
  removeAllListeners(eventName?: string | symbol): this;
  emit(eventName: string | symbol, ...args: unknown[]): boolean;
  listeners(eventName: string | symbol): Listener[];
  rawListeners(eventName: string | symbol): Listener[];
  listenerCount(eventName: string | symbol, listener?: Listener): number;
  eventNames(): (string | symbol)[];
  setMaxListeners(n: number): this;
  getMaxListeners(): number;
}

/** `events.on` options. */
export interface OnOptions {
  signal?: AbortSignal;
  close?: readonly (string | symbol)[];
  highWaterMark?: number;
  lowWaterMark?: number;
  highWatermark?: number;
  lowWatermark?: number;
}

/** What `require("events")` is: the constructor with Node's statics. */
export interface EventEmitterConstructor {
  new (options?: EventEmitterOptions): EventEmitter;
  (this: unknown, options?: EventEmitterOptions): void;
  prototype: EventEmitter;
  EventEmitter: EventEmitterConstructor;
  EventEmitterAsyncResource: typeof EventEmitterAsyncResourceClass;
  usingDomains: boolean;
  captureRejectionSymbol: symbol;
  captureRejections: boolean;
  errorMonitor: symbol;
  defaultMaxListeners: number;
  readonly kMaxEventTargetListeners: symbol;
  readonly kMaxEventTargetListenersWarned: symbol;
  init(this: unknown, options?: EventEmitterOptions): void;
  once(
    emitter: unknown,
    name: string | symbol,
    options?: { signal?: AbortSignal },
  ): Promise<unknown[]>;
  on(
    emitter: unknown,
    name: string | symbol,
    options?: OnOptions,
  ): AsyncIterableIterator<unknown[]>;
  getEventListeners(emitter: unknown, name: string | symbol): Listener[];
  getMaxListeners(emitter: unknown): number;
  setMaxListeners(n?: number, ...eventTargets: unknown[]): void;
  listenerCount(emitter: unknown, name: string | symbol): number;
  addAbortListener(signal: AbortSignal, listener: (event: Event) => void): Disposable;
}

/** The value `addAbortListener` returns. */
export interface Disposable {
  [key: symbol]: () => void;
}

type ListenerArray = Listener[] & { warned?: boolean };
type Events = Record<string | symbol, Listener | ListenerArray | undefined>;
type Wrapped = Listener & { listener?: Listener };

interface Internal extends EventEmitter {
  _events: Events | undefined;
  _eventsCount: number;
  _maxListeners: number | undefined;
  [kCapture]: boolean;
  [kShapeMode]: boolean;
  [kRejection]?: (error: unknown, event: string | symbol, ...args: unknown[]) => void;
  pause?: () => void;
  resume?: () => void;
}

interface MinimalProcess {
  emitWarning?: (warning: Error) => void;
  nextTick?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
}

const kRejection = Symbol.for("nodejs.rejection");
const kCapture = Symbol("kCapture");
const kErrorMonitor = Symbol("events.errorMonitor");
const kShapeMode = Symbol("shapeMode");
const kMaxEventTargetListeners = Symbol("events.maxEventTargetListeners");
const kMaxEventTargetListenersWarned = Symbol("events.maxEventTargetListenersWarned");
const kWatermarkData = Symbol.for("nodejs.watermarkData");
const SymbolDispose: symbol =
  (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for("nodejs.dispose");
const AsyncIteratorPrototype: object = Object.getPrototypeOf(
  Object.getPrototypeOf(async function* () {}).prototype,
);

function currentProcess(): MinimalProcess | undefined {
  return (globalThis as { process?: MinimalProcess }).process;
}

// The platform's own, taken before a program can replace the global.
const platformQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

function nextTick(callback: () => void): void {
  const process = currentProcess();
  if (typeof process?.nextTick === "function") {
    process.nextTick(callback);
  } else {
    platformQueueMicrotask(callback);
  }
}

let defaultMaxListeners = 10;

const EventEmitter = function EventEmitter(this: Internal, opts?: EventEmitterOptions) {
  // `EventEmitter` here is the function itself (the expression's own name).
  (EventEmitter as unknown as EventEmitterConstructor).init.call(this, opts);
} as unknown as EventEmitterConstructor;

const proto = EventEmitter.prototype as Internal;

EventEmitter.EventEmitter = EventEmitter;
EventEmitter.usingDomains = false;
EventEmitter.captureRejectionSymbol = kRejection;
EventEmitter.errorMonitor = kErrorMonitor;

Object.defineProperty(EventEmitter, "captureRejections", {
  get() {
    return proto[kCapture];
  },
  set(value: unknown) {
    validateBoolean(value, "EventEmitter.captureRejections");
    proto[kCapture] = value;
  },
  enumerable: true,
});

Object.defineProperty(proto, kCapture, {
  value: false,
  writable: true,
  enumerable: false,
});

proto._events = undefined;
proto._eventsCount = 0;
proto._maxListeners = undefined;

Object.defineProperty(EventEmitter, "defaultMaxListeners", {
  enumerable: true,
  get() {
    return defaultMaxListeners;
  },
  set(arg: unknown) {
    validateNumber(arg, "defaultMaxListeners", 0);
    defaultMaxListeners = arg;
  },
});

Object.defineProperties(EventEmitter, {
  kMaxEventTargetListeners: {
    value: kMaxEventTargetListeners,
    enumerable: false,
    configurable: false,
    writable: false,
  },
  kMaxEventTargetListenersWarned: {
    value: kMaxEventTargetListenersWarned,
    enumerable: false,
    configurable: false,
    writable: false,
  },
});

function isEventTarget(value: unknown): value is EventTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as EventTarget).addEventListener === "function" &&
    typeof (value as EventTarget).dispatchEvent === "function"
  );
}

EventEmitter.setMaxListeners = function setMaxListeners(
  n: number = defaultMaxListeners,
  ...eventTargets: unknown[]
): void {
  validateNumber(n, "setMaxListeners", 0);
  if (eventTargets.length === 0) {
    defaultMaxListeners = n;
    return;
  }
  for (const target of eventTargets) {
    if (isEventTarget(target)) {
      const record = target as unknown as Record<symbol, unknown>;
      record[kMaxEventTargetListeners] = n;
      record[kMaxEventTargetListenersWarned] = false;
    } else if (
      typeof target === "object" &&
      target !== null &&
      typeof (target as EventEmitter).setMaxListeners === "function"
    ) {
      (target as EventEmitter).setMaxListeners(n);
    } else {
      throw invalidArgType("eventTargets", ["EventEmitter", "EventTarget"], target);
    }
  }
};

EventEmitter.init = function init(this: unknown, opts?: EventEmitterOptions): void {
  const self = this as Internal;
  if (
    self._events === undefined ||
    self._events === (Object.getPrototypeOf(self) as Internal)._events
  ) {
    self._events = Object.create(null) as Events;
    self._eventsCount = 0;
    self[kShapeMode] = false;
  } else {
    self[kShapeMode] = true;
  }

  self._maxListeners ||= undefined;

  if (opts?.captureRejections) {
    validateBoolean(opts.captureRejections, "options.captureRejections");
    self[kCapture] = Boolean(opts.captureRejections);
  } else {
    self[kCapture] = proto[kCapture];
  }
};

function addCatch(that: Internal, promise: unknown, type: string | symbol, args: unknown[]): void {
  if (!that[kCapture]) {
    return;
  }
  // A thenable's `then` could be a getter that throws.
  try {
    const then = (promise as { then?: unknown }).then;
    if (typeof then === "function") {
      then.call(promise, undefined, (err: unknown) => {
        // On the next tick, to avoid a follow-up rejection from this promise.
        nextTick(() => emitUnhandledRejectionOrErr(that, err, type, args));
      });
    }
  } catch (err) {
    that.emit("error", err);
  }
}

function emitUnhandledRejectionOrErr(
  ee: Internal,
  err: unknown,
  type: string | symbol,
  args: unknown[],
): void {
  const handler = ee[kRejection];
  if (typeof handler === "function") {
    handler.call(ee, err, type, ...args);
    return;
  }
  // Turn capturing off while emitting, or a rejecting handler would loop.
  const prev = ee[kCapture];
  try {
    ee[kCapture] = false;
    ee.emit("error", err);
  } finally {
    ee[kCapture] = prev;
  }
}

proto.setMaxListeners = function setMaxListeners(this: Internal, n: number) {
  validateNumber(n, "setMaxListeners", 0);
  this._maxListeners = n;
  return this;
};

function getMaxListenersOf(that: Internal): number {
  if (that._maxListeners === undefined) {
    return EventEmitter.defaultMaxListeners;
  }
  return that._maxListeners;
}

proto.getMaxListeners = function getMaxListeners(this: Internal) {
  return getMaxListenersOf(this);
};

function getUnhandledErrorException(args: unknown[]): unknown {
  const er = args.length > 0 ? args[0] : undefined;
  if (er instanceof Error) {
    return er;
  }
  let stringified: string;
  try {
    stringified = inspectValue(er);
  } catch {
    stringified = String(er);
  }
  const err = makeNodeError<Error & { context?: unknown }>(
    "ERR_UNHANDLED_ERROR",
    `Unhandled error. (${stringified})`,
  );
  err.context = er;
  return err;
}

proto.emit = function emit(this: Internal, type: string | symbol, ...args: unknown[]): boolean {
  let doError = type === "error";

  const events = this._events;
  if (events !== undefined) {
    if (doError && events[kErrorMonitor] !== undefined) {
      this.emit(kErrorMonitor, ...args);
    }
    doError &&= events.error === undefined;
  } else if (!doError) {
    return false;
  }

  // No 'error' listener: throw.
  if (doError) {
    throw getUnhandledErrorException(args); // Unhandled 'error' event
  }

  const handler = (events as Events)[type];
  if (handler === undefined) {
    return false;
  }

  if (typeof handler === "function") {
    const result = Reflect.apply(handler, this, args);
    if (result !== undefined && result !== null) {
      addCatch(this, result, type, args);
    }
  } else {
    // Copy first: a listener that adds or removes listeners does not change
    // who receives this emit.
    const listeners = handler.slice();
    for (let i = 0; i < listeners.length; ++i) {
      const result = Reflect.apply(listeners[i], this, args);
      if (result !== undefined && result !== null) {
        addCatch(this, result, type, args);
      }
    }
  }
  return true;
};

function addListenerTo(
  target: Internal,
  type: string | symbol,
  listener: Listener,
  prepend: boolean,
): Internal {
  validateFunction(listener, "listener");

  let events = target._events;
  let existing: Listener | ListenerArray | undefined;
  if (events === undefined) {
    events = target._events = Object.create(null) as Events;
    target._eventsCount = 0;
  } else {
    // Emit 'newListener' before adding, so a 'newListener' listener does not
    // see itself.
    if (events.newListener !== undefined) {
      target.emit("newListener", type, (listener as Wrapped).listener ?? listener);
      // A 'newListener' handler may have replaced `_events`.
      events = target._events as Events;
    }
    existing = events[type];
  }

  if (existing === undefined) {
    events[type] = listener;
    ++target._eventsCount;
  } else {
    let list: ListenerArray;
    if (typeof existing === "function") {
      list = prepend ? [listener, existing] : [existing, listener];
      events[type] = list;
    } else {
      list = existing;
      if (prepend) {
        list.unshift(listener);
      } else {
        list.push(listener);
      }
    }

    const m = getMaxListenersOf(target);
    if (m > 0 && list.length > m && !list.warned) {
      warnMaxListenersExceeded(target, type, list, m);
    }
  }
  return target;
}

function warnMaxListenersExceeded(
  target: Internal,
  type: string | symbol,
  existing: ListenerArray,
  m: number,
): void {
  existing.warned = true;
  const warning = new Error(
    `Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} listeners ` +
      `added to ${inspectValue(target, -1)}. MaxListeners is ${m}. Use emitter.setMaxListeners() to increase limit`,
  );
  Object.assign(warning, {
    name: "MaxListenersExceededWarning",
    emitter: target,
    type,
    count: existing.length,
  });
  const process = currentProcess();
  if (typeof process?.emitWarning === "function") {
    process.emitWarning(warning);
  }
}

proto.addListener = function addListener(
  this: Internal,
  type: string | symbol,
  listener: Listener,
) {
  return addListenerTo(this, type, listener, false);
};

proto.on = proto.addListener;

proto.prependListener = function prependListener(
  this: Internal,
  type: string | symbol,
  listener: Listener,
) {
  return addListenerTo(this, type, listener, true);
};

function onceWrap(target: Internal, type: string | symbol, listener: Listener): Wrapped {
  let fired = false;
  const wrapper: Wrapped = function (this: unknown, ...args: unknown[]) {
    if (fired) {
      return undefined;
    }
    fired = true;
    target.removeListener(type, wrapper);
    return Reflect.apply(listener, target, args);
  };
  wrapper.listener = listener;
  return wrapper;
}

proto.once = function once(this: Internal, type: string | symbol, listener: Listener) {
  validateFunction(listener, "listener");
  this.on(type, onceWrap(this, type, listener));
  return this;
};

proto.prependOnceListener = function prependOnceListener(
  this: Internal,
  type: string | symbol,
  listener: Listener,
) {
  validateFunction(listener, "listener");
  this.prependListener(type, onceWrap(this, type, listener));
  return this;
};

proto.removeListener = function removeListener(
  this: Internal,
  type: string | symbol,
  listener: Listener,
) {
  validateFunction(listener, "listener");

  const events = this._events;
  if (events === undefined) {
    return this;
  }
  const list = events[type];
  if (list === undefined) {
    return this;
  }

  if (list === listener || (list as Wrapped).listener === listener) {
    this._eventsCount -= 1;
    if (this[kShapeMode]) {
      events[type] = undefined;
    } else if (this._eventsCount === 0) {
      this._events = Object.create(null) as Events;
    } else {
      delete events[type];
    }
    if (events.removeListener !== undefined) {
      this.emit("removeListener", type, (list as Wrapped).listener || listener);
    }
  } else if (typeof list !== "function") {
    let position = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || (list[i] as Wrapped).listener === listener) {
        position = i;
        break;
      }
    }
    if (position < 0) {
      return this;
    }
    if (position === 0) {
      list.shift();
    } else {
      list.splice(position, 1);
    }
    if (list.length === 1) {
      events[type] = list[0];
    }
    if (events.removeListener !== undefined) {
      this.emit("removeListener", type, listener);
    }
  }
  return this;
};

proto.off = proto.removeListener;

proto.removeAllListeners = function removeAllListeners(this: Internal, type?: string | symbol) {
  const events = this._events;
  if (events === undefined) {
    return this;
  }

  // Nobody listens for 'removeListener': no need to emit it.
  if (events.removeListener === undefined) {
    if (arguments.length === 0) {
      this._events = Object.create(null) as Events;
      this._eventsCount = 0;
    } else if (events[type as string | symbol] !== undefined) {
      if (--this._eventsCount === 0) {
        this._events = Object.create(null) as Events;
      } else {
        delete events[type as string | symbol];
      }
    }
    this[kShapeMode] = false;
    return this;
  }

  // Emit 'removeListener' for every listener of every event.
  if (arguments.length === 0) {
    for (const key of Reflect.ownKeys(events)) {
      if (key === "removeListener") {
        continue;
      }
      this.removeAllListeners(key);
    }
    this.removeAllListeners("removeListener");
    this._events = Object.create(null) as Events;
    this._eventsCount = 0;
    this[kShapeMode] = false;
    return this;
  }

  const listeners = events[type as string | symbol];
  if (typeof listeners === "function") {
    this.removeListener(type as string | symbol, listeners);
  } else if (listeners !== undefined) {
    // LIFO order
    for (let i = listeners.length - 1; i >= 0; i--) {
      this.removeListener(type as string | symbol, listeners[i]);
    }
  }
  return this;
};

function listenersOf(target: Internal, type: string | symbol, unwrap: boolean): Listener[] {
  const events = target._events;
  if (events === undefined) {
    return [];
  }
  const evlistener = events[type];
  if (evlistener === undefined) {
    return [];
  }
  if (typeof evlistener === "function") {
    return unwrap ? [(evlistener as Wrapped).listener || evlistener] : [evlistener];
  }
  if (!unwrap) {
    return evlistener.slice();
  }
  return evlistener.map((listener) => {
    const orig = (listener as Wrapped).listener;
    return typeof orig === "function" ? orig : listener;
  });
}

proto.listeners = function listeners(this: Internal, type: string | symbol) {
  return listenersOf(this, type, true);
};

proto.rawListeners = function rawListeners(this: Internal, type: string | symbol) {
  return listenersOf(this, type, false);
};

function listenerCountOf(this: Internal, type: string | symbol, listener?: Listener): number {
  const events = this._events;
  if (events !== undefined) {
    const evlistener = events[type];
    if (typeof evlistener === "function") {
      if (listener != null) {
        return listener === evlistener || listener === (evlistener as Wrapped).listener ? 1 : 0;
      }
      return 1;
    }
    if (evlistener !== undefined) {
      if (listener != null) {
        let matching = 0;
        for (const item of evlistener) {
          if (item === listener || (item as Wrapped).listener === listener) {
            matching++;
          }
        }
        return matching;
      }
      return evlistener.length;
    }
  }
  return 0;
}

proto.listenerCount = listenerCountOf;

proto.eventNames = function eventNames(this: Internal) {
  if (this._eventsCount === 0) {
    return [];
  }
  const events = this._events as Events;
  // A listener removed in shape mode leaves its key with an undefined value.
  return Reflect.ownKeys(events).filter((key) => events[key] !== undefined);
};

/**
 * `EventEmitter.listenerCount(emitter, eventName)` (deprecated in Node, still
 * exported).
 */
EventEmitter.listenerCount = function listenerCount(
  emitter: unknown,
  type: string | symbol,
): number {
  const candidate = emitter as EventEmitter;
  if (typeof candidate.listenerCount === "function") {
    return candidate.listenerCount(type);
  }
  return listenerCountOf.call(emitter as Internal, type);
};

/** A copy of the listeners for `type` on an EventEmitter. */
export function getEventListeners(emitterOrTarget: unknown, type: string | symbol): Listener[] {
  const candidate = emitterOrTarget as EventEmitter;
  if (typeof candidate?.listeners === "function") {
    return candidate.listeners(type);
  }
  if (isEventTarget(emitterOrTarget)) {
    throw new Error(
      "events.getEventListeners() on an EventTarget is not supported by webnode: the browser does not expose its listeners",
    );
  }
  throw invalidArgType("emitter", ["EventEmitter", "EventTarget"], emitterOrTarget);
}

/** The max-listener setting of an EventEmitter or EventTarget. */
export function getMaxListeners(emitterOrTarget: unknown): number {
  const candidate = emitterOrTarget as Internal | null | undefined;
  if (typeof candidate?.getMaxListeners === "function") {
    return getMaxListenersOf(candidate);
  }
  if (isEventTarget(emitterOrTarget)) {
    const value = (emitterOrTarget as unknown as Record<symbol, unknown>)[kMaxEventTargetListeners];
    return typeof value === "number" ? value : defaultMaxListeners;
  }
  throw invalidArgType("emitter", ["EventEmitter", "EventTarget"], emitterOrTarget);
}

/** `events.addAbortListener(signal, listener)`: listens once; returns a disposable. */
export function addAbortListener(
  signal: AbortSignal,
  listener: (event: Event) => void,
): Disposable {
  if (signal === undefined) {
    throw invalidArgType("signal", "AbortSignal", signal);
  }
  validateAbortSignal(signal, "signal");
  validateFunction(listener, "listener");

  let remove: () => void;
  if (signal.aborted) {
    let disposed = false;
    platformQueueMicrotask(() => {
      if (!disposed) {
        listener(new Event("abort"));
      }
    });
    remove = () => {
      disposed = true;
    };
  } else {
    signal.addEventListener("abort", listener, { once: true });
    remove = () => {
      signal.removeEventListener("abort", listener);
    };
  }
  return {
    [SymbolDispose]() {
      remove();
    },
  };
}

type AgnosticEmitter = {
  on?: (name: string | symbol, listener: Listener) => unknown;
  once?: (name: string | symbol, listener: Listener) => unknown;
  removeListener?: (name: string | symbol, listener: Listener) => unknown;
  addEventListener?: (name: string, listener: Listener, flags?: unknown) => void;
  removeEventListener?: (name: string, listener: Listener, flags?: unknown) => void;
};

function agnosticRemoveListener(
  emitter: unknown,
  name: string | symbol,
  listener: Listener,
  flags?: unknown,
): void {
  const target = emitter as AgnosticEmitter;
  if (typeof target.removeListener === "function") {
    target.removeListener(name, listener);
  } else if (typeof target.removeEventListener === "function") {
    target.removeEventListener(name as string, listener, flags);
  } else {
    throw invalidArgType("emitter", "EventEmitter", emitter);
  }
}

function agnosticAddListener(
  emitter: unknown,
  name: string | symbol,
  listener: Listener,
  flags?: { once?: boolean },
): void {
  const target = emitter as AgnosticEmitter;
  if (typeof target.on === "function") {
    if (flags?.once) {
      (target.once as NonNullable<AgnosticEmitter["once"]>)(name, listener);
    } else {
      target.on(name, listener);
    }
  } else if (typeof target.addEventListener === "function") {
    target.addEventListener(name as string, listener, flags);
  } else {
    throw invalidArgType("emitter", "EventEmitter", emitter);
  }
}

/**
 * A promise for the next `name` event (its arguments as an array); rejects on
 * 'error' (EventEmitters only) or when `signal` aborts.
 */
export async function once(
  emitter: unknown,
  name: string | symbol,
  options: { signal?: AbortSignal } = {},
): Promise<unknown[]> {
  validateObject(options, "options");
  const { signal } = options;
  validateAbortSignal(signal, "options.signal");
  if (signal?.aborted) {
    throw new AbortError(undefined, { cause: signal.reason });
  }
  return new Promise((resolve, reject) => {
    const errorListener = (err: unknown) => {
      agnosticRemoveListener(emitter, name, resolver);
      if (signal != null) {
        agnosticRemoveListener(signal, "abort", abortListener);
      }
      reject(err);
    };
    const resolver = (...args: unknown[]) => {
      if (typeof (emitter as AgnosticEmitter).removeListener === "function") {
        agnosticRemoveListener(emitter, "error", errorListener);
      }
      if (signal != null) {
        agnosticRemoveListener(signal, "abort", abortListener);
      }
      resolve(args);
    };
    agnosticAddListener(emitter, name, resolver, { once: true });
    if (name !== "error" && typeof (emitter as AgnosticEmitter).once === "function") {
      // EventTarget has no 'error' semantics; only EventEmitters reject on it.
      (emitter as EventEmitter).once("error", errorListener);
    }
    function abortListener() {
      agnosticRemoveListener(emitter, name, resolver);
      agnosticRemoveListener(emitter, "error", errorListener);
      reject(new AbortError(undefined, { cause: signal?.reason }));
    }
    if (signal != null) {
      agnosticAddListener(signal, "abort", abortListener, { once: true });
    }
  });
}

/**
 * An async iterator over `event` events (each value is the argument array).
 * Ends on a `close` event or `return()`, throws on 'error' or abort.
 */
export function on(
  emitter: unknown,
  event: string | symbol,
  options: OnOptions = {},
): AsyncIterableIterator<unknown[]> {
  validateObject(options, "options");
  const signal = options.signal;
  validateAbortSignal(signal, "options.signal");
  if (signal?.aborted) {
    throw new AbortError(undefined, { cause: signal.reason });
  }
  const highWatermark = options.highWaterMark ?? options.highWatermark ?? Number.MAX_SAFE_INTEGER;
  validateInteger(highWatermark, "options.highWaterMark", 1);
  const lowWatermark = options.lowWaterMark ?? options.lowWatermark ?? 1;
  validateInteger(lowWatermark, "options.lowWaterMark", 1);

  const target = emitter as Internal;
  const unconsumedEvents: unknown[][] = [];
  const unconsumedPromises: {
    resolve: (result: IteratorResult<unknown[]>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let paused = false;
  let error: unknown = null;
  let finished = false;

  const iterator = Object.setPrototypeOf(
    {
      next(): Promise<IteratorResult<unknown[]>> {
        // First the events already received.
        if (unconsumedEvents.length > 0) {
          const value = unconsumedEvents.shift() as unknown[];
          if (paused && unconsumedEvents.length < lowWatermark) {
            target.resume?.();
            paused = false;
          }
          return Promise.resolve({ value, done: false });
        }
        // Then an error, once.
        if (error) {
          const p = Promise.reject(error);
          error = null;
          return p;
        }
        if (finished) {
          return closeHandler();
        }
        return new Promise((resolve, reject) => {
          unconsumedPromises.push({ resolve, reject });
        });
      },
      return(): Promise<IteratorResult<unknown[]>> {
        return closeHandler();
      },
      throw(err: unknown): void {
        if (!err || !(err instanceof Error)) {
          throw invalidArgType("EventEmitter.AsyncIterator", "Error", err);
        }
        errorHandler(err);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [kWatermarkData]: {
        get size() {
          return unconsumedEvents.length;
        },
        get low() {
          return lowWatermark;
        },
        get high() {
          return highWatermark;
        },
        get isPaused() {
          return paused;
        },
      },
    },
    AsyncIteratorPrototype,
  ) as AsyncIterableIterator<unknown[]>;

  const added: [unknown, string | symbol, Listener][] = [];
  const listen = (source: unknown, name: string | symbol, handler: Listener) => {
    agnosticAddListener(source, name, handler);
    added.push([source, name, handler]);
  };
  const removeAll = () => {
    while (added.length > 0) {
      const [source, name, handler] = added.pop() as [unknown, string | symbol, Listener];
      agnosticRemoveListener(source, name, handler);
    }
  };

  listen(emitter, event, (...args: unknown[]) => {
    eventHandler(args);
  });
  if (event !== "error" && typeof (emitter as AgnosticEmitter).on === "function") {
    listen(emitter, "error", errorHandler);
  }
  const closeEvents = options.close;
  if (closeEvents?.length) {
    for (const closeEvent of closeEvents) {
      listen(emitter, closeEvent, closeHandler);
    }
  }

  const abortDisposable = signal ? addAbortListener(signal, abortListener) : null;

  return iterator;

  function abortListener() {
    errorHandler(new AbortError(undefined, { cause: signal?.reason }));
  }

  function eventHandler(value: unknown[]) {
    const waiting = unconsumedPromises.shift();
    if (waiting) {
      waiting.resolve({ value, done: false });
      return;
    }
    unconsumedEvents.push(value);
    if (!paused && unconsumedEvents.length > highWatermark) {
      paused = true;
      target.pause?.();
    }
  }

  function errorHandler(err: unknown) {
    const waiting = unconsumedPromises.shift();
    if (waiting) {
      waiting.reject(err);
    } else {
      error = err;
    }
    void closeHandler();
  }

  function closeHandler(): Promise<IteratorResult<unknown[]>> {
    abortDisposable?.[SymbolDispose]();
    removeAll();
    finished = true;
    paused = false;
    const doneResult: IteratorResult<unknown[]> = { value: undefined, done: true };
    while (unconsumedPromises.length > 0) {
      (unconsumedPromises.shift() as (typeof unconsumedPromises)[number]).resolve(doneResult);
    }
    return Promise.resolve(doneResult);
  }
}

/**
 * Node's `EventEmitterAsyncResource`, without async_hooks: emits like an
 * EventEmitter; the async-resource members throw, since webnode has no
 * async_hooks.
 */
class EventEmitterAsyncResourceClass extends EventEmitter {
  constructor(options?: string | (EventEmitterOptions & { name?: string })) {
    if (typeof options !== "string" && new.target === EventEmitterAsyncResourceClass) {
      validateString(options?.name, "options.name");
    }
    super(typeof options === "string" ? undefined : options);
  }

  get asyncResource(): never {
    throw new Error(
      "events.EventEmitterAsyncResource.asyncResource is not supported by webnode (no async_hooks)",
    );
  }

  get asyncId(): never {
    throw new Error(
      "events.EventEmitterAsyncResource.asyncId is not supported by webnode (no async_hooks)",
    );
  }

  get triggerAsyncId(): never {
    throw new Error(
      "events.EventEmitterAsyncResource.triggerAsyncId is not supported by webnode (no async_hooks)",
    );
  }

  emitDestroy(): never {
    throw new Error(
      "events.EventEmitterAsyncResource.emitDestroy is not supported by webnode (no async_hooks)",
    );
  }
}
Object.defineProperty(EventEmitterAsyncResourceClass, "name", {
  value: "EventEmitterAsyncResource",
});

Object.defineProperty(EventEmitter, "EventEmitterAsyncResource", {
  enumerable: true,
  get: () => EventEmitterAsyncResourceClass,
  set: undefined,
  configurable: true,
});

EventEmitter.once = once;
EventEmitter.on = on;
EventEmitter.getEventListeners = getEventListeners;
EventEmitter.getMaxListeners = getMaxListeners;
EventEmitter.addAbortListener = addAbortListener;

/** `require("events").errorMonitor`. */
export const errorMonitor = kErrorMonitor;
/** `require("events").captureRejectionSymbol`. */
export const captureRejectionSymbol = kRejection;
/** `require("events").EventEmitterAsyncResource`. */
export const EventEmitterAsyncResource = EventEmitterAsyncResourceClass;
export { EventEmitter };

export default EventEmitter;

// The `timers` builtin: Node's `Timeout` and `Immediate` objects over the
// platform's own timers. The host installs these functions as the globals, so
// the natives are captured when this module is evaluated.
//
// Each Timeout owns one native timer (re-armed on every repeat and refresh).
// Immediates sit in one FIFO queue: each immediate runs in its own task, after
// the I/O messages already queued, so microtasks queued by one immediate run
// before the next one starts. Every callback runs as a macrotask
// (eventLoop.ts), so its nextTick callbacks run as it returns.
//
// Liveness: an active, ref'd timer or immediate holds one `runtime().ref()`,
// released when it fires (unless it repeats), is cleared, or is `unref()`'d.
import { bindToCurrentContext } from "./async_hooks";
import { macrotaskSource, runMacrotask } from "./eventLoop";
import { validateFunction, validateNumber } from "./internalErrors";
import { runtime, type ProcessRuntime } from "../runtime";
import timersPromises from "./timers_promises";
import { emitWarning } from "./util";

type AnyFunction = (...args: never[]) => unknown;
type NativeHandle = ReturnType<typeof globalThis.setTimeout>;

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

/** The largest delay Node accepts (2^31 - 1 ms); anything outside [1, max] becomes 1. */
export const TIMEOUT_MAX = 2 ** 31 - 1;

const disposeSymbol: symbol =
  (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for("nodejs.dispose");

/** The runtime, or null when none is installed (tests of other modules). */
function currentRuntime(): ProcessRuntime | null {
  try {
    return runtime();
  } catch {
    return null;
  }
}

/**
 * One liveness reference that can be taken and given back any number of times;
 * it remembers the runtime it took the ref from.
 */
class Liveness {
  #holder: ProcessRuntime | null = null;

  set(held: boolean): void {
    if (held && this.#holder === null) {
      const rt = currentRuntime();
      if (rt !== null) {
        rt.ref();
        this.#holder = rt;
      }
    } else if (!held && this.#holder !== null) {
      const rt = this.#holder;
      this.#holder = null;
      rt.unref();
    }
  }
}

function coerceDelay(after: unknown): number {
  let delay = (after as number) * 1;
  if (!(delay >= 1 && delay <= TIMEOUT_MAX)) {
    if (delay > TIMEOUT_MAX) {
      emitWarning(
        `${delay} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`,
        "TimeoutOverflowWarning",
        undefined,
        undefined,
      );
    }
    delay = 1;
  }
  return delay;
}

let nextTimerId = 1;
/** Timeouts whose numeric id escaped through `[Symbol.toPrimitive]`, so `clearTimeout(id)` finds them. */
const knownTimersById = new Map<number, Timeout>();

/** Node's `Timeout`, as `setTimeout` and `setInterval` return it. */
export class Timeout {
  _idleTimeout: number;
  _onTimeout: AnyFunction | null;
  _timerArgs: unknown[] | undefined;
  _repeat: number | null;
  _destroyed: boolean;
  #id = nextTimerId++;
  #refed: boolean;
  #hasPrimitive = false;
  #native: NativeHandle | null = null;
  /** Counts the arms: a native timer whose callback waited past a re-arm does nothing. */
  #armed = 0;
  #liveness = new Liveness();

  constructor(
    callback: AnyFunction,
    after: unknown,
    args: unknown[] | undefined,
    isRepeat: boolean,
    isRefed: boolean,
  ) {
    const delay = coerceDelay(after);
    this._idleTimeout = delay;
    this._onTimeout = callback;
    this._timerArgs = args;
    this._repeat = isRepeat ? delay : null;
    this._destroyed = false;
    this.#refed = isRefed;
    this.#arm();
  }

  #arm(): void {
    if (this.#native !== null) {
      nativeClearTimeout(this.#native);
    }
    const armed = ++this.#armed;
    this.#native = nativeSetTimeout(() => runMacrotask(() => this.#fire(armed)), this._idleTimeout);
    this._destroyed = false;
    this.#liveness.set(this.#refed);
  }

  #disarm(): void {
    if (this.#native !== null) {
      nativeClearTimeout(this.#native);
      this.#native = null;
    }
    this._destroyed = true;
    this.#liveness.set(false);
    if (this.#hasPrimitive) {
      knownTimersById.delete(this.#id);
    }
  }

  #fire(armed: number): void {
    if (armed !== this.#armed) {
      // Refreshed while this run waited behind earlier ticks: the new arm runs it.
      return;
    }
    this.#native = null;
    const callback = this._onTimeout;
    if (typeof callback !== "function") {
      this.#disarm();
      return;
    }
    try {
      const args = this._timerArgs;
      if (args === undefined) {
        (callback as () => unknown).call(this);
      } else {
        (callback as (...a: unknown[]) => unknown).apply(this, args);
      }
    } finally {
      // As in Node: a repeating timer re-arms after its callback (even one that
      // threw) unless the callback cleared it; a one-shot timer is done unless
      // the callback refreshed it.
      if (this._repeat !== null && this._idleTimeout !== -1) {
        this._idleTimeout = this._repeat;
        if (this.#native === null) {
          this.#arm();
        }
      } else if (this.#native === null && !this._destroyed) {
        this.#disarm();
      }
    }
  }

  /** Re-arms the timer from now with its original delay; revives one that already fired. */
  refresh(): this {
    if (this._idleTimeout >= 0 && this._onTimeout !== null) {
      this.#arm();
    }
    return this;
  }

  /** Lets the process exit while this timer is pending. */
  unref(): this {
    this.#refed = false;
    this.#liveness.set(false);
    return this;
  }

  /** Keeps the process alive while this timer is pending (the default). */
  ref(): this {
    this.#refed = true;
    if (!this._destroyed) {
      this.#liveness.set(true);
    }
    return this;
  }

  hasRef(): boolean {
    return this.#refed;
  }

  /** Cancels the timer; same as `clearTimeout(this)`. */
  close(): this {
    clearTimeout(this);
    return this;
  }

  /** Stops the timer for good (`clearTimeout`'s work). */
  _unenroll(): void {
    this._onTimeout = null;
    this._idleTimeout = -1;
    this.#disarm();
  }

  /** The numeric id `clearTimeout` also accepts. */
  [Symbol.toPrimitive](): number {
    if (!this.#hasPrimitive && !this._destroyed) {
      this.#hasPrimitive = true;
      knownTimersById.set(this.#id, this);
    }
    return this.#id;
  }
}

Object.defineProperty(Timeout.prototype, disposeSymbol, {
  value: function dispose(this: Timeout) {
    clearTimeout(this);
  },
  writable: true,
  configurable: true,
  enumerable: false,
});

/** `setTimeout(callback, delay, ...args)`. */
export function setTimeout<A extends unknown[]>(
  callback: (...args: A) => unknown,
  after?: number,
  ...args: A
): Timeout {
  validateFunction(callback, "callback");
  return new Timeout(
    bindToCurrentContext(callback as AnyFunction),
    after,
    args.length === 0 ? undefined : args,
    false,
    true,
  );
}

/** `setInterval(callback, delay, ...args)`. */
export function setInterval<A extends unknown[]>(
  callback: (...args: A) => unknown,
  repeat?: number,
  ...args: A
): Timeout {
  validateFunction(callback, "callback");
  return new Timeout(
    bindToCurrentContext(callback as AnyFunction),
    repeat,
    args.length === 0 ? undefined : args,
    true,
    true,
  );
}

/** `clearTimeout(timeout)`: accepts a Timeout, its numeric id (or that id as a string), or anything else (ignored). */
export function clearTimeout(timer: unknown): void {
  if (timer instanceof Timeout) {
    if (timer._onTimeout !== null) {
      timer._unenroll();
    }
    return;
  }
  if (typeof timer === "number" || typeof timer === "string") {
    const known = knownTimersById.get(Number(timer));
    if (known !== undefined) {
      known._unenroll();
    }
  }
}

/** `clearInterval`: the same as `clearTimeout`, as in Node. */
export function clearInterval(timer: unknown): void {
  clearTimeout(timer);
}

// ---------------------------------------------------------------------------
// Immediates

const immediateQueue: Immediate[] = [];

function runOneImmediate(): void {
  immediateQueue.shift()?._run();
}

/** Queues one task that runs the oldest immediate. */
const postImmediateTask = macrotaskSource(runOneImmediate);

/** Node's `Immediate`, as `setImmediate` returns it. */
export class Immediate {
  _onImmediate: AnyFunction | null;
  _argv: unknown[] | undefined;
  _destroyed = false;
  #refed = true;
  #liveness = new Liveness();

  constructor(callback: AnyFunction, args: unknown[] | undefined) {
    this._onImmediate = callback;
    this._argv = args;
    immediateQueue.push(this);
    this.#liveness.set(true);
    postImmediateTask();
  }

  /** Runs the callback; called by the queue. */
  _run(): void {
    const callback = this._onImmediate;
    this._onImmediate = null;
    this._destroyed = true;
    this.#liveness.set(false);
    if (typeof callback !== "function") {
      return;
    }
    const args = this._argv;
    if (args === undefined) {
      (callback as () => unknown).call(this);
    } else {
      (callback as (...a: unknown[]) => unknown).apply(this, args);
    }
  }

  /** Cancels the immediate (`clearImmediate`'s work). */
  _clear(): void {
    this._destroyed = true;
    this._onImmediate = null;
    this.#liveness.set(false);
    const index = immediateQueue.indexOf(this);
    if (index !== -1) {
      immediateQueue.splice(index, 1);
    }
  }

  ref(): this {
    this.#refed = true;
    if (!this._destroyed) {
      this.#liveness.set(true);
    }
    return this;
  }

  unref(): this {
    this.#refed = false;
    this.#liveness.set(false);
    return this;
  }

  hasRef(): boolean {
    return this.#refed;
  }
}

Object.defineProperty(Immediate.prototype, disposeSymbol, {
  value: function dispose(this: Immediate) {
    clearImmediate(this);
  },
  writable: true,
  configurable: true,
  enumerable: false,
});

/** `setImmediate(callback, ...args)`. */
export function setImmediate<A extends unknown[]>(
  callback: (...args: A) => unknown,
  ...args: A
): Immediate {
  validateFunction(callback, "callback");
  return new Immediate(
    bindToCurrentContext(callback as AnyFunction),
    args.length === 0 ? undefined : args,
  );
}

/** `clearImmediate(immediate)`: anything but a pending Immediate is ignored. */
export function clearImmediate(immediate: unknown): void {
  if (immediate instanceof Immediate && !immediate._destroyed) {
    immediate._clear();
  }
}

// ---------------------------------------------------------------------------
// The legacy, deprecated item API: `enroll(item, ms)`, `active(item)`,
// `_unrefActive(item)`, `unenroll(item)` schedule `item._onTimeout()`.

interface LegacyItem {
  _idleTimeout?: number;
  _onTimeout?: () => unknown;
}

const legacyTimers = new WeakMap<object, Timeout>();

function legacyStart(item: unknown, refed: boolean): void {
  if (item instanceof Timeout) {
    if (!refed) {
      item.unref();
    }
    item.refresh();
    return;
  }
  const legacy = item as LegacyItem;
  const msecs = legacy._idleTimeout;
  if (msecs === undefined || msecs < 0) {
    return;
  }
  legacyTimers.get(item as object)?._unenroll();
  const timer = new Timeout(
    function onTimeout() {
      legacyTimers.delete(item as object);
      if (typeof legacy._onTimeout === "function") {
        legacy._onTimeout();
      }
    },
    msecs,
    undefined,
    false,
    refed,
  );
  legacyTimers.set(item as object, timer);
}

/** `timers.enroll(item, msecs)` (deprecated): sets the item's delay. */
export function enroll(item: object, msecs: number): void {
  validateNumber(msecs, "msecs", 0, TIMEOUT_MAX);
  unenroll(item);
  (item as LegacyItem)._idleTimeout = msecs;
}

/** `timers.unenroll(item)` (deprecated): stops the item's timer. */
export function unenroll(item: object): void {
  if (item instanceof Timeout) {
    item._unenroll();
    return;
  }
  legacyTimers.get(item)?._unenroll();
  legacyTimers.delete(item);
  (item as LegacyItem)._idleTimeout = -1;
}

/** `timers.active(item)` (deprecated): (re)starts the item's timer. */
export function active(item: object): void {
  legacyStart(item, true);
}

/** `timers._unrefActive(item)` (deprecated): like `active`, without keeping the process alive. */
export function _unrefActive(item: object): void {
  legacyStart(item, false);
}

const timers = {
  setTimeout,
  clearTimeout,
  setImmediate,
  clearImmediate,
  setInterval,
  clearInterval,
  _unrefActive,
  active,
  unenroll,
  enroll,
} as {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setImmediate: typeof setImmediate;
  clearImmediate: typeof clearImmediate;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  _unrefActive: typeof _unrefActive;
  active: typeof active;
  unenroll: typeof unenroll;
  enroll: typeof enroll;
  readonly promises: unknown;
};

Object.defineProperty(timers, "promises", {
  configurable: true,
  enumerable: true,
  get: () => timersPromises,
});

export default timers;

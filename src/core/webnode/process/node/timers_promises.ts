// The `timers/promises` builtin (also `timers.promises`): promise and
// async-iterator forms of webnode's timers, ported from Node 22's
// lib/timers/promises.js. They schedule through ./timers, so `{ ref: false }`
// and liveness behave as the callback forms do.
import { AbortError, validateAbortSignal, validateBoolean, validateObject } from "./internalErrors";
import {
  clearImmediate,
  clearInterval,
  clearTimeout,
  setImmediate as setImmediateCallback,
  setInterval as setIntervalCallback,
  setTimeout as setTimeoutCallback,
  type Immediate,
  type Timeout,
} from "./timers";

/** The options every promise timer takes. */
export interface TimerOptions {
  signal?: AbortSignal;
  ref?: boolean;
}

function abortError(signal: AbortSignal): AbortError {
  return new AbortError(undefined, { cause: signal.reason });
}

function readOptions(options: unknown): TimerOptions {
  validateObject(options, "options");
  const { signal, ref = true } = options as TimerOptions;
  validateAbortSignal(signal, "options.signal");
  validateBoolean(ref, "options.ref");
  return { signal, ref };
}

function schedule<T>(
  options: unknown,
  start: (resolve: () => void) => Timeout | Immediate,
  cancel: (handle: Timeout | Immediate) => void,
  value: T,
): Promise<T> {
  let signal: AbortSignal | undefined;
  let ref: boolean | undefined;
  try {
    ({ signal, ref } = readOptions(options));
  } catch (error) {
    return Promise.reject(error);
  }
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const handle = start(() => {
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
      resolve(value);
    });
    if (!ref) {
      handle.unref();
    }
    if (signal !== undefined) {
      onAbort = () => {
        cancel(handle);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** `await setTimeout(delay, value, { signal, ref })`: resolves with `value` after `delay` ms. */
export function setTimeout<T = void>(
  delay?: number,
  value?: T,
  options: TimerOptions = {},
): Promise<T> {
  return schedule(
    options,
    (resolve) => setTimeoutCallback(resolve, delay),
    (handle) => clearTimeout(handle),
    value as T,
  );
}

/** `await setImmediate(value, { signal, ref })`: resolves with `value` in the check phase. */
export function setImmediate<T = void>(value?: T, options: TimerOptions = {}): Promise<T> {
  return schedule(
    options,
    (resolve) => setImmediateCallback(resolve),
    (handle) => clearImmediate(handle),
    value as T,
  );
}

/**
 * `for await (const v of setInterval(delay, value, { signal, ref }))`: yields
 * `value` once per tick; ticks that pass while the consumer is busy are
 * yielded back to back, as in Node.
 */
export async function* setInterval<T = void>(
  delay?: number,
  value?: T,
  options: TimerOptions = {},
): AsyncGenerator<T, void, unknown> {
  const { signal, ref } = readOptions(options);
  if (signal?.aborted) {
    throw abortError(signal);
  }
  let onAbort: (() => void) | undefined;
  let interval: Timeout | undefined;
  try {
    let notYielded = 0;
    let wake: (() => void) | undefined;
    interval = setIntervalCallback(() => {
      notYielded++;
      if (wake !== undefined) {
        const resolve = wake;
        wake = undefined;
        resolve();
      }
    }, delay);
    if (!ref) {
      interval.unref();
    }
    if (signal !== undefined) {
      onAbort = () => {
        if (interval !== undefined) {
          clearInterval(interval);
        }
        if (wake !== undefined) {
          const resolve = wake;
          wake = undefined;
          resolve();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    while (!signal?.aborted) {
      if (notYielded === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      for (; notYielded > 0; notYielded--) {
        yield value as T;
      }
    }
    throw abortError(signal);
  } finally {
    if (interval !== undefined) {
      clearInterval(interval);
    }
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** `timers/promises.scheduler`: the Scheduling API's `wait` and `yield`. */
export class Scheduler {
  /** Resolves on the next check phase (`setImmediate`). */
  yield(): Promise<void> {
    return setImmediate();
  }

  /** Resolves after `delay` ms (`setTimeout(delay, undefined, options)`). */
  wait(delay: number, options?: TimerOptions): Promise<void> {
    return setTimeout(delay, undefined, options);
  }
}

/** The shared `scheduler` instance. */
export const scheduler = new Scheduler();

const timersPromises = {
  setTimeout,
  setImmediate,
  setInterval,
  scheduler,
};

export default timersPromises;

// When an asynchronous `fs` call (callback or promise) completes. The work is
// done at once, as a sync call, but Node delivers the result from the event
// loop's poll phase, so timers, immediates and port messages (preview HTTP
// requests, IPC) run between one completion and the next. Delivering in a
// microtask would starve them all: a delay-free poll loop over `fs.access`
// would never see the timer it waits for. So each completion runs in a task of
// its own, from a MessageChannel (not setTimeout, which the browser clamps),
// and holds the process alive while it waits, as pending I/O does in Node.
import { runtime, type ProcessRuntime } from "../../runtime";
import { runNextTicks } from "../process";
import { isArgumentError } from "./errors";

const queue: (() => void)[] = [];
let channel: MessageChannel | null = null;
let held: ProcessRuntime | null = null;

function runOne(): void {
  const next = queue.shift();
  try {
    if (next !== undefined) {
      next();
      runNextTicks();
    }
  } finally {
    if (queue.length === 0 && held !== null) {
      const rt = held;
      held = null;
      rt.unref();
    }
  }
}

/** Runs `deliver` in a task of its own, after the tasks already queued. */
export function complete(deliver: () => void): void {
  queue.push(deliver);
  if (held === null) {
    try {
      held = runtime();
      held.ref();
    } catch {
      held = null;
    }
  }
  if (channel === null) {
    channel = new MessageChannel();
    channel.port1.onmessage = runOne;
    // Under Node (tests) a port with a listener would keep the loop alive.
    (channel.port1 as unknown as { unref?: () => void }).unref?.();
  }
  channel.port2.postMessage(null);
}

/**
 * A promise for `op()`, run now and settled from the event loop. An argument
 * error rejects at once, as Node's validation does before any I/O.
 */
export function settleLater<T>(op: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let value: T;
    try {
      value = op();
    } catch (error) {
      if (isArgumentError(error)) {
        reject(error);
      } else {
        complete(() => reject(error));
      }
      return;
    }
    complete(() => resolve(value));
  });
}

/** `fn`, with its promise settled from the event loop rather than in a microtask. */
export function settledLater<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return function (this: unknown, ...args: A): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      fn.apply(this, args).then(
        (value) => complete(() => resolve(value)),
        (error: unknown) =>
          isArgumentError(error) ? reject(error) : complete(() => reject(error)),
      );
    });
  };
}

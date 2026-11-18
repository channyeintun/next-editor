// When an asynchronous `fs` call (callback or promise) completes. The work is
// done at once, as a sync call, but Node delivers the result from the event
// loop's poll phase, so timers, immediates and port messages (preview HTTP
// requests, IPC) run between one completion and the next. Delivering in a
// microtask would starve them all: a delay-free poll loop over `fs.access`
// would never see the timer it waits for. So each completion runs in a task of
// its own and holds the process alive while it waits, as pending I/O does in
// Node. Each completion is a macrotask (eventLoop.ts): the nextTick callbacks
// it queues run as it returns. It runs in the async context of the call that
// queued it, as the callback of a Node request does.
import { runtime, type ProcessRuntime } from "../../runtime";
import { bindToCurrentContext } from "../async_hooks";
import { macrotaskSource } from "../eventLoop";
import { isArgumentError } from "./errors";

const queue: (() => void)[] = [];
let held: ProcessRuntime | null = null;

function runOne(): void {
  const next = queue.shift();
  try {
    next?.();
  } finally {
    if (queue.length === 0 && held !== null) {
      const rt = held;
      held = null;
      rt.unref();
    }
  }
}

/** Queues one task that runs the oldest completion. */
const postCompletionTask = macrotaskSource(runOne);

/**
 * Runs `deliver` in a task of its own, after the tasks already queued, in the
 * async context current now.
 */
export function complete(deliver: () => void): void {
  queue.push(bindToCurrentContext(deliver));
  if (held === null) {
    try {
      held = runtime();
      held.ref();
    } catch {
      held = null;
    }
  }
  postCompletionTask();
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

// The jobs Node runs on its thread pool: zlib's one-shot functions and
// crypto's random bytes and key derivation. Node calls back from the event
// loop, in the async context of the call, and a pending job keeps the process
// alive. Here the work runs on the process's own thread and its callback is
// delivered the same way: in an event-loop task of its own (fs/completion.ts,
// which carries the context of the call that queued the task), never through
// a global timer, which a program may have replaced with a fake clock.
import { bindToCurrentContext } from "../async_hooks";
import { holdProcess } from "../eventLoop";
import { complete } from "../fs/completion";

/** A Node-style callback: the error, or null and the result. */
export type JobCallback<T> = (error: Error | null, result?: T) => void;

/**
 * Runs `work` in an event-loop task of its own and calls back, in that task,
 * with what it returned or threw.
 */
export function runJob<T>(work: () => T, callback: JobCallback<T>): void {
  complete(() => {
    let result: T;
    try {
      result = work();
    } catch (error) {
      callback(error as Error);
      return;
    }
    callback(null, result);
  });
}

/**
 * Calls back, in an event-loop task of its own, with what `work` settles
 * with: for work that gives way to the event loop by itself while it runs.
 */
export function settleJob<T>(work: Promise<T>, callback: JobCallback<T>): void {
  // The task is queued when the work settles, so the call's context is taken here.
  const deliver = bindToCurrentContext(callback);
  const release = holdProcess();
  work.then(
    (result) => {
      complete(() => deliver(null, result));
      release();
    },
    (error: unknown) => {
      complete(() => deliver(error as Error));
      release();
    },
  );
}

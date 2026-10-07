import type { Context } from "hono";

/** Hands work to the runtime to finish after the response has been sent. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * The request's `waitUntil`, for work the response must not wait on, such as a
 * cache write that only a later request reads. Undefined when the request has
 * no ExecutionContext: Hono throws on `c.executionCtx` then, which is the case
 * for `app.request()` in the worker test suite. Callers await the work instead.
 */
export function requestWaitUntil(c: Pick<Context, "executionCtx">): WaitUntil | undefined {
  try {
    const executionCtx = c.executionCtx;
    return (promise) => executionCtx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

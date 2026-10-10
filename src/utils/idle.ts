/**
 * Runs `callback` the next time the main thread is idle, or after `timeoutMs`
 * at the latest. Safari has no requestIdleCallback, so it gets the usual
 * one-tick timer instead. Returns a function that cancels a callback that
 * hasn't run yet.
 */
export function runWhenIdle(callback: () => void, timeoutMs: number): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => callback(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(callback, 1);
  return () => window.clearTimeout(timer);
}

/**
 * runWhenIdle, but only after the window `load` event, so optional work never
 * competes with the page's own fonts, images and scripts.
 */
export function runWhenIdleAfterLoad(callback: () => void, timeoutMs: number): () => void {
  let cancelIdle: (() => void) | null = null;
  const handleLoad = () => {
    cancelIdle = runWhenIdle(callback, timeoutMs);
  };
  if (document.readyState === "complete") {
    handleLoad();
  } else {
    window.addEventListener("load", handleLoad, { once: true });
  }
  return () => {
    window.removeEventListener("load", handleLoad);
    cancelIdle?.();
  };
}

interface YieldingScheduler {
  yield?: () => Promise<void>;
}

/**
 * Lets the browser handle input and paint before the caller continues, keeping the
 * caller's place ahead of ordinary tasks. Uses scheduler.yield() where the browser has
 * it; Chrome 94-128 have `scheduler` without `yield`, and other browsers have neither, so
 * they get a MessageChannel message instead. A timer would do, but it is clamped and, in
 * a background tab, throttled to a second or more per call.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: YieldingScheduler }).scheduler;
  if (typeof scheduler?.yield === "function") {
    return scheduler.yield();
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

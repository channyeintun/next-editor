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

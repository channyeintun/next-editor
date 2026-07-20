import type { TextAnchor } from "./plan";

/**
 * Monaco-free primitives shared by the driver, Performer, and controller.
 * Kept out of driver.ts so unit tests (and the Performer) never pull the
 * Monaco runtime into their module graph.
 */

export class StudioActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioActionError";
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new StudioActionError("The render was cancelled"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new StudioActionError("The render was cancelled"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WaitUntilOptions {
  timeoutMs: number;
  signal: AbortSignal;
  description: string;
  intervalMs?: number;
}

export async function waitUntil(
  predicate: () => boolean,
  { timeoutMs, signal, description, intervalMs = 16 }: WaitUntilOptions,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) {
      throw new StudioActionError("The render was cancelled");
    }
    if (predicate()) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new StudioActionError(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await abortableSleep(intervalMs, signal);
  }
}

/**
 * Resolve a text anchor to an insertion offset: the end of the `occurrence`-th
 * exact match of `after` ("" anchors the start of the file). Returns null when
 * the occurrence does not exist — callers must fail, not guess.
 */
export function resolveAnchorOffset(content: string, anchor: TextAnchor): number | null {
  if (anchor.after === "") {
    return 0;
  }
  let index = -1;
  for (let found = 0; found < anchor.occurrence; found++) {
    index = content.indexOf(anchor.after, index + 1);
    if (index === -1) {
      return null;
    }
  }
  return index + anchor.after.length;
}

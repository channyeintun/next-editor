// What bundled packages get when they `require("process")`: the running
// process's object when the `node` program has installed one, and a working
// `nextTick` before that or in the programs that never do (the shell, npm).
type Tick = (...args: unknown[]) => void;

interface ProcessLike {
  nextTick?: (callback: Tick, ...args: unknown[]) => void;
}

function current(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

const shim = new Proxy(
  {
    nextTick(callback: Tick, ...args: unknown[]): void {
      const process = current();
      if (process?.nextTick) {
        process.nextTick(callback, ...args);
      } else {
        queueMicrotask(() => callback(...args));
      }
    },
  } as Record<string | symbol, unknown>,
  {
    get(target, key) {
      if (key === "nextTick") {
        return target.nextTick;
      }
      const process = current() as Record<string | symbol, unknown> | undefined;
      return process ? process[key] : undefined;
    },
  },
);

export default shim;

// @vitest-environment node
// Asynchronous `fs` results arrive from the event loop, as Node delivers them
// from its poll phase: timers and immediates run between completions, so a
// delay-free polling loop sees the timer it waits for. Each check runs on
// webnode's fs and on the host's real `node:fs`.
import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "../async_hooks";
import { createProcess } from "../process";
import { makeSides, type AnyFs, type Sides } from "./compare.testkit";

let sides: Sides;

beforeEach(() => {
  sides = makeSides();
});

afterEach(() => {
  sides.cleanup();
});

const LIMIT = 200_000;

/** Polls with `fs.access` callbacks until a 5 ms timer sets a flag; -1 if it never runs. */
function pollCallbacks(fs: AnyFs, dir: string): Promise<number> {
  let flag = false;
  setTimeout(() => {
    flag = true;
  }, 5);
  return new Promise((done) => {
    const poll = (i: number) =>
      fs.access(dir, () => (flag ? done(i) : i > LIMIT ? done(-1) : poll(i + 1)));
    poll(0);
  });
}

/** The same loop over `fs.promises.stat`. */
async function pollPromises(fs: AnyFs, dir: string): Promise<number> {
  let flag = false;
  setTimeout(() => {
    flag = true;
  }, 5);
  for (let i = 0; i <= LIMIT; i++) {
    await fs.promises.stat(dir);
    if (flag) {
      return i;
    }
  }
  return -1;
}

describe("fs completions run from the event loop", () => {
  for (const side of ["node", "ours"] as const) {
    it(`${side}: a callback polling loop lets a timer run`, async () => {
      const { fs, root } = sides[side];
      expect(await pollCallbacks(fs, root)).toBeGreaterThan(-1);
    });

    it(`${side}: a promise polling loop lets a timer run`, async () => {
      const { fs, root } = sides[side];
      expect(await pollPromises(fs, root)).toBeGreaterThan(-1);
    });

    it(`${side}: a FileHandle polling loop lets a timer run`, async () => {
      const { fs, root } = sides[side];
      fs.writeFileSync(`${root}/f`, "x");
      const handle = await fs.promises.open(`${root}/f`);
      let flag = false;
      setTimeout(() => {
        flag = true;
      }, 5);
      let i = 0;
      while (!flag && i <= LIMIT) {
        await handle.stat();
        i++;
      }
      await handle.close();
      expect(flag).toBe(true);
    });

    it(`${side}: a microtask queued after the call runs before the callback`, async () => {
      const { fs, root } = sides[side];
      const order: string[] = [];
      await new Promise<void>((resolve) => {
        fs.stat(root, () => {
          order.push("stat");
          resolve();
        });
        void Promise.resolve().then(() => order.push("micro"));
      });
      expect(order).toEqual(["micro", "stat"]);
    });

    it(`${side}: a callback's ticks run before its promise jobs, a promise job's after them`, async () => {
      const { fs, root } = sides[side];
      const nextTick =
        side === "node"
          ? process.nextTick.bind(process)
          : createProcess({ loadBuiltin: () => undefined, ipc: null }).nextTick;
      const order: string[] = [];
      fs.stat(root, () => {
        void Promise.resolve().then(() => {
          order.push("promise");
          nextTick(() => order.push("promise>tick"));
          void Promise.resolve().then(() => order.push("promise>promise"));
        });
        nextTick(() => order.push("tick"));
      });
      for (let i = 0; i < 100 && order.length < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(order).toEqual(["tick", "promise", "promise>promise", "promise>tick"]);
    });

    it(`${side}: a Dir reads its directory from the event loop and hands out the rest on ticks`, async () => {
      const { fs, root } = sides[side];
      const nextTick =
        side === "node"
          ? process.nextTick.bind(process)
          : createProcess({ loadBuiltin: () => undefined, ipc: null }).nextTick;
      for (const name of ["a", "b", "c"]) {
        fs.writeFileSync(`${root}/${name}`, "");
      }
      const order: string[] = [];
      const dir = fs.opendirSync(root);
      await new Promise<void>((resolve) => {
        dir.read(() => {
          order.push("read 1");
          dir.read(() => {
            order.push("read 2");
            nextTick(() => order.push("tick in read 2"));
            void Promise.resolve().then(() => order.push("promise in read 2"));
            dir.read(() => {
              order.push("read 3");
              dir.close((error) => {
                order.push(`close ${error}`);
                dir.close((again) => {
                  order.push(`close again ${(again as { code?: string } | null)?.code}`);
                  resolve();
                });
                order.push("after close again");
                nextTick(() => order.push("tick after close again"));
              });
              order.push("after close call");
            });
            order.push("after read 3 call");
          });
          nextTick(() => order.push("tick in read 1"));
          void Promise.resolve().then(() => order.push("promise in read 1"));
        });
        order.push("after read 1 call");
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(order).toEqual([
        "after read 1 call",
        "read 1",
        "tick in read 1",
        "read 2",
        "after read 3 call",
        "tick in read 2",
        "read 3",
        "after close call",
        "promise in read 1",
        "promise in read 2",
        "close null",
        "after close again",
        "close again ERR_DIR_CLOSED",
        "tick after close again",
      ]);
    });

    it(`${side}: a Dir's promises settle from the event loop when the directory is read`, async () => {
      const { fs, root } = sides[side];
      for (const name of ["a", "b"]) {
        fs.writeFileSync(`${root}/${name}`, "");
      }
      const order: string[] = [];
      const dir = fs.opendirSync(root);
      const first = dir.read().then(() => order.push("read 1"));
      void Promise.resolve().then(() => order.push("promise after read 1 call"));
      await first;
      // The second entry came with the first: no wait for the event loop.
      const second = dir.read().then(() => order.push("read 2"));
      void Promise.resolve()
        .then(() => {})
        .then(() => {})
        .then(() => order.push("three promise jobs after read 2 call"));
      await second;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const closing = dir.close().then(() => order.push("close"));
      void Promise.resolve().then(() => order.push("promise after close call"));
      await closing;
      expect(order).toEqual([
        "promise after read 1 call",
        "read 1",
        "read 2",
        "three promise jobs after read 2 call",
        "promise after close call",
        "close",
      ]);
    });
  }

  it("argument errors still reject at once", async () => {
    const { fs } = sides.ours;
    await expect(fs.promises.stat(42 as never)).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    expect(() => fs.stat(42 as never, () => {})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("holds the process alive while a completion waits", async () => {
    const { fs, root } = sides.ours;
    const refs: number[] = [];
    const runtime = sides.runtime as unknown as { ref(): void; unref(): void };
    const ref = runtime.ref.bind(runtime);
    const unref = runtime.unref.bind(runtime);
    runtime.ref = () => {
      refs.push(1);
      ref();
    };
    runtime.unref = () => {
      refs.push(-1);
      unref();
    };
    await new Promise((resolve) => fs.stat(root, resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refs).toEqual([1, -1]);
  });

  // Last: webnode starts tracking async contexts with its first AsyncLocalStorage.
  for (const side of ["node", "ours"] as const) {
    it(`${side}: a callback runs in the async context of its call`, async () => {
      const { fs, root } = sides[side];
      const storage: { run(store: string, callback: () => void): void; getStore(): unknown } =
        side === "node" ? new NodeAsyncLocalStorage<string>() : new AsyncLocalStorage<string>();
      // Which of the two finishes first is the thread pool's call (Node gives
      // no order, and a busy pool does flip them), so each callback reports
      // under its own name and the test waits for both.
      const seen = await new Promise<Record<string, unknown>>((resolve) => {
        const stores: Record<string, unknown> = {};
        const report = (call: string) => {
          stores[call] = storage.getStore();
          if ("stat" in stores && "readdir" in stores) resolve(stores);
        };
        storage.run("first", () => fs.stat(root, () => report("stat")));
        storage.run("second", () => fs.readdir(root, () => report("readdir")));
      });
      expect(seen).toEqual({ stat: "first", readdir: "second" });
    });
  }
});

// @vitest-environment node
// Asynchronous `fs` results arrive from the event loop, as Node delivers them
// from its poll phase: timers and immediates run between completions, so a
// delay-free polling loop sees the timer it waits for. Each check runs on
// webnode's fs and on the host's real `node:fs`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});

// @vitest-environment node
// A program that recurses until its stack ends, calling the filesystem at every
// level, gets the engine's RangeError for it, as it would in Node. The error
// must not land inside the module (half an operation done) and must not leave
// the lock or the caller's slot taken: either would cost every other process
// its filesystem.
import { describe, expect, it } from "vitest";
import { OFFSET } from "./abi";
import { createSharedFilesystem } from "./boot";
import { SharedFs } from "./sharedFs";

const O_WRONLY_CREAT_TRUNC = 0o1101;
const text = new TextEncoder().encode("contents");

/** Calls of different depth and kind, each made at every level of a runaway recursion. */
const OPERATIONS: [string, (fs: SharedFs, n: number) => unknown][] = [
  ["stat", (fs) => fs.stat("/work/a/b/c/file.txt", true)],
  ["exists", (fs) => fs.exists("/work/missing")],
  ["readdir", (fs) => fs.readdir("/work/a")],
  ["readFile", (fs) => fs.readFile("/work/a/b/c/file.txt")],
  ["realpath through links", (fs) => fs.realpath("/work/link/b/c/file.txt")],
  [
    "writeFile",
    (fs, n) => fs.writeFile(`/work/out-${n % 7}.txt`, text, O_WRONLY_CREAT_TRUNC, 0o644),
  ],
  ["mkdir -p", (fs, n) => fs.mkdir(`/work/deep/${n % 5}/x/y/z`, true, 0o755)],
  [
    "rename",
    (fs) =>
      // Whichever of the two names the file has now: a trial may end on either.
      fs.exists("/work/r0") ? fs.rename("/work/r0", "/work/r1") : fs.rename("/work/r1", "/work/r0"),
  ],
  [
    "a failing call",
    (fs) => {
      try {
        fs.readFile("/work/nowhere/at/all");
      } catch {
        // ENOENT at every level.
      }
    },
  ],
];

/** Recursions whose frames differ in size, so the stack ends at different points of a call. */
const SHAPES: ((call: (n: number) => unknown) => void)[] = [
  (call) => {
    const recurse = (n: number): number => {
      call(n);
      return recurse(n + 1) + 1;
    };
    recurse(0);
  },
  (call) => {
    const recurse = (n: number, a: number, b: number, c: number): number => {
      call(n);
      return recurse(n + 1, b, c, a) + a + b + c;
    };
    recurse(0, 1, 2, 3);
  },
  (call) => {
    const recurse = (n: number, pad: number[]): number => {
      call(n);
      const [a, b, c, d, e, f, g] = pad;
      return recurse(n + 1, [b, c, d, e, f, g, a]) + a + b + c + d + e + f + g;
    };
    recurse(0, [1, 2, 3, 4, 5, 6, 7]);
  },
  (call) => {
    const recurse = (n: number): number => {
      try {
        call(n);
      } finally {
        void n;
      }
      return recurse(n + 1) + 1;
    };
    recurse(0);
  },
];

function prepare(fs: SharedFs): void {
  fs.mkdir("/work/a/b/c", true, 0o755);
  fs.writeFile("/work/a/b/c/file.txt", text, O_WRONLY_CREAT_TRUNC, 0o644);
  fs.symlink("/work/a", "/work/link");
  fs.writeFile("/work/r0", text, O_WRONLY_CREAT_TRUNC, 0o644);
}

// Each case recurses to the end of the stack dozens of times, seconds of work
// on a busy machine.
describe("a caller that runs out of stack", { timeout: 60_000 }, () => {
  const shared = createSharedFilesystem();
  if (shared === null) {
    throw new Error("no shared memory in this environment");
  }
  prepare(shared.fs);
  const admission = shared.admit();
  if (admission === null) {
    throw new Error("no slot");
  }
  const instances: [string, SharedFs][] = [
    ["the kernel's instance", shared.fs],
    [
      "a process's instance",
      new SharedFs({
        module: shared.module,
        memory: shared.memory,
        now: Date.now,
        entry: admission,
        deliversEvents: false,
      }),
    ],
  ];
  const words = new Int32Array(shared.memory.buffer);
  const word = (offset: number) => words[(shared.fs.base + offset) / 4];

  for (const [who, fs] of instances) {
    it.each(OPERATIONS)(
      `gets a RangeError and leaves the filesystem whole: ${who}, %s`,
      (_name, operation) => {
        for (const shape of SHAPES) {
          for (let trial = 0; trial < 6; trial++) {
            let thrown: unknown;
            try {
              // A different offset each trial moves where the stack ends within a call.
              const offset = (depth: number): unknown =>
                depth === 0 ? shape((n) => operation(fs, n)) : offset(depth - 1);
              offset(trial * 3);
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBeInstanceOf(RangeError);
            expect(word(OFFSET.poisoned)).toBe(0);
            expect(word(OFFSET.lock)).toBe(0);
            expect(word(OFFSET.slots + admission.slot * 4)).toBe(admission.token);
            expect(fs.stat("/work", true).mode & 0o170000).toBe(0o040000);
          }
        }
        expect(shared.fs.check()).toBe(0);
      },
    );
  }

  it("lets the kernel retire the process afterwards without waiting", () => {
    expect(shared.retire(admission.slot, () => {})).toBe("outside");
  });
});

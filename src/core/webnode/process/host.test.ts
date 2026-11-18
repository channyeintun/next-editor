// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../kernel/vfs/types";
import type { ProcessInit } from "../protocol";
import { setRuntime } from "./runtime";
import { createFakeRuntime } from "./testing/fakeRuntime";
import type { FakeRuntime } from "./testing/fakeRuntime";

const programs = vi.hoisted(() => ({
  /** The worker entry's listener of the kernel's messages. */
  listener: null as ((event: Event) => void) | null,
  /** The runtime the next process client connects to. */
  runtime: null as FakeRuntime | null,
  /** What the package manager program throws as it starts. */
  failure: null as Error | null,
}));

// The entry's macrotask machinery is the event loop's matter: its listener is
// called here as a kernel message would call it.
vi.mock("./node/eventLoop", () => ({
  addMacrotaskListener: (_target: EventTarget, _type: string, listener: (event: Event) => void) => {
    programs.listener = listener;
  },
}));
vi.mock("./sysClient", () => ({
  createProcessClient: () => ({ runtime: programs.runtime, receive: () => {} }),
}));
vi.mock("./programs/npm/index", () => ({
  runPackageManager: async () => {
    throw programs.failure;
  },
}));
vi.mock("./programs/node", () => ({ runNode: async () => {} }));
vi.mock("./programs/shell/index", () => ({ runShell: async () => 0 }));

const decoder = new TextDecoder();

afterEach(() => {
  setRuntime(null);
  vi.unstubAllGlobals();
});

/** Starts the package manager program in the worker entry; resolves with the status it exited with. */
async function start(rt: FakeRuntime, failure: Error): Promise<number> {
  programs.runtime = rt;
  programs.failure = failure;
  let exited: (code: number) => void = () => {};
  const status = new Promise<number>((resolve) => {
    exited = resolve;
  });
  // The real exit never returns; the worker is gone after it.
  vi.spyOn(rt.processes, "exit").mockImplementation((code) => {
    exited(code);
    return undefined as never;
  });
  vi.stubGlobal("postMessage", () => {});
  await import("./host");
  // What of its init message the entry reads before the program starts.
  const init: Pick<ProcessInit, "type" | "program" | "argv"> = {
    type: "init",
    program: "npm",
    argv: ["npm"],
  };
  if (programs.listener === null) {
    throw new Error("the worker entry listens for no message");
  }
  programs.listener(new MessageEvent("message", { data: init }));
  return status;
}

function failure(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at start (program.js:1:1)`;
  return error;
}

describe("a program that fails as it starts", () => {
  it("has its error written whole to fd 2, a pipe, and exits 1", async () => {
    const rt = createFakeRuntime({ cwd: "/" });
    const long = failure(`cannot start ${"x".repeat(100_000)}`);
    expect(await start(rt, long)).toBe(1);
    expect(rt.stderr()).toBe(`${long.stack}\n`);
  });

  it("has its error written to fd 2, a file, at the file's offset", async () => {
    const rt = createFakeRuntime({ cwd: "/" });
    rt.fs.close(2);
    expect(rt.fs.open("/err.log", O_WRONLY | O_CREAT | O_TRUNC, 0o644)).toBe(2);
    rt.fs.write(2, new TextEncoder().encode("before\n"), null);
    expect(await start(rt, failure("cannot start"))).toBe(1);
    expect(decoder.decode(rt.fs.readFile("/err.log"))).toBe(
      "before\nError: cannot start\n    at start (program.js:1:1)\n",
    );
    expect(rt.stderr()).toBe("");
  });

  it("exits 1 when fd 2's reader has gone, or fd 2 is closed", async () => {
    const gone = createFakeRuntime({ cwd: "/" });
    gone.closeReader(2);
    expect(await start(gone, failure("cannot start"))).toBe(1);
    const closed = createFakeRuntime({ cwd: "/" });
    closed.fs.close(2);
    expect(await start(closed, failure("cannot start"))).toBe(1);
  });
});

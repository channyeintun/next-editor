// @vitest-environment node
// child_process over the fake runtime: a spawn that cannot start reports
// 'error' and then 'close' with the negative errno, a child's handle and its
// IPC channel behave as Node's, and the sync forms' results and errors carry
// what Node's do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemError, toSystemErrorRecord } from "../../errors";
import { setRuntime } from "../runtime";
import type { ExitStatus, SpawnSyncRequest } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
} from "./child_process";
import { runMacrotask } from "./eventLoop";
import { postIpcExit } from "./internal/ipcEnvelope";
import { createProcess } from "./process";
import { setTimeout as nodeSetTimeout } from "./timers";

// Every timer child_process arms goes through this spy, so a test can tell
// whether the module waited for anything.
vi.mock("./timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./timers")>();
  return { ...actual, setTimeout: vi.fn<typeof actual.setTimeout>(actual.setTimeout) };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `done()` holds, a millisecond at a time. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await sleep(1);
  }
}

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

describe("spawn", () => {
  it("emits 'error' then 'close' with -2 when the command does not exist", async () => {
    fake.processes.spawn = () => {
      throw createSystemError("ENOENT", "spawn missing", "missing");
    };
    const child = spawn("missing", ["a"]);
    const events: unknown[][] = [];
    child.on("error", (error: { code?: string }) => events.push(["error", error.code]));
    child.on("close", (code: unknown, signal: unknown) => events.push(["close", code, signal]));
    // 'close' waits for the output pipes, from the event loop.
    for (let i = 0; i < 20 && events.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(events).toEqual([
      ["error", "ENOENT"],
      ["close", -2, null],
    ]);
    expect(child.exitCode).toBe(-2);
    expect(fake.refCount).toBe(0);
  });

  // What real Node v26 does for a child that cannot start (test/cases/spawn-failure.cjs).
  it("gives a child that cannot start the stdio streams it asked for, which end as Node's do", async () => {
    fake.processes.spawn = () => {
      throw createSystemError("ENOENT", "spawn missing", "missing");
    };
    const child = spawn("missing", [], { stdio: ["pipe", "pipe", "pipe", "pipe", "ignore"] });
    expect(child.stdio.map((stream) => (stream === null ? "null" : "stream"))).toEqual([
      "stream",
      "stream",
      "stream",
      "stream",
      "null",
    ]);
    expect([child.stdin, child.stdout, child.stderr]).toEqual(child.stdio.slice(0, 3));
    const seen: Record<string, string[]> = { child: [], stdin: [], stdout: [], stderr: [] };
    const order: string[] = [];
    for (const name of ["stdin", "stdout", "stderr"] as const) {
      for (const event of ["end", "close", "error"]) {
        child[name]!.on(event, (error?: { code?: string }) => {
          seen[name].push(error?.code ? `${event} ${error.code}` : event);
          order.push(`${name} ${event}`);
        });
      }
    }
    child.stdout!.on("data", () => seen.stdout.push("data"));
    child.stdin!.write("x", (error?: Error | null) => {
      seen.stdin.push(`write ${(error as { code?: string } | null | undefined)?.code}`);
    });
    child.on("error", (error: { code?: string }) => seen.child.push(`error ${error.code}`));
    const closed = new Promise<void>((resolve) =>
      child.on("close", (code: number, signal: unknown) => {
        seen.child.push(`close ${code} ${signal}`);
        order.push("close");
        resolve();
      }),
    );
    await closed;
    expect(order.indexOf("close")).toBeGreaterThan(order.indexOf("stdout end"));
    expect(order.indexOf("close")).toBeGreaterThan(order.indexOf("stderr end"));
    expect([child.stdout!.readable, child.stdin!.writable]).toEqual([false, false]);
    await new Promise<void>((resolve) =>
      child.stdin!.write("late", (error?: Error | null) => {
        seen.stdin.push(`late write ${(error as { code?: string } | null | undefined)?.code}`);
        resolve();
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual({
      child: ["error ENOENT", "close -2 null"],
      stdin: ["write EPIPE", "close", "late write ERR_STREAM_DESTROYED"],
      stdout: ["end", "close"],
      stderr: ["end", "close"],
    });
    expect(fake.refCount).toBe(0);
  });
});

describe("a child's handle", () => {
  // Real Node v26 for a command that does not exist: "kill function / ref
  // function / unref function / send undefined / disconnect undefined",
  // "unref returned", "kill returned false", and stdin.destroyed is true
  // inside the 'error' listener. execa binds child.kill right after spawn().
  it("has kill, ref and unref even when the child could not start, and no send without a channel", async () => {
    fake.processes.spawn = () => {
      throw createSystemError("ENOENT", "spawn missing", "missing");
    };
    const child = spawn("missing");
    expect(
      ["kill", "ref", "unref"].map((name) => Object.hasOwn(ChildProcess.prototype, name)),
    ).toEqual([true, true, true]);
    expect(
      (["kill", "ref", "unref", "send", "disconnect"] as const).map((name) => typeof child[name]),
    ).toEqual(["function", "function", "function", "undefined", "undefined"]);
    child.unref();
    child.ref();
    expect(child.kill()).toBe(false);
    expect(child.killed).toBe(false);
    // An unknown signal is refused whatever became of the child.
    expect(() => child.kill("SIGNOPE")).toThrow(
      expect.objectContaining({ code: "ERR_UNKNOWN_SIGNAL" }),
    );
    const seen: unknown[] = [];
    child.on("error", (error: { code?: string }) =>
      seen.push([error.code, child.exitCode, child.stdin!.destroyed]),
    );
    await until(() => seen.length > 0);
    expect(seen).toEqual([["ENOENT", -2, true]]);
    expect(fake.refCount).toBe(0);
  });

  // Real Node v26 for `spawn(missing)`: "error …", "tick queued after spawn()",
  // "promise job …", "immediate …", "close -2 null", "stdin close".
  it("closes a failed child's stdin after the child's own 'close', as Node's handle does", async () => {
    fake.processes.spawn = () => {
      throw createSystemError("ENOENT", "spawn missing", "missing");
    };
    const order: string[] = [];
    const piped = spawn("missing");
    piped.on("error", () => order.push("piped error"));
    piped.on("close", () => order.push("piped close"));
    piped.stdin!.on("close", () => order.push("piped stdin close"));
    await until(() => order.length === 3);
    const alone = spawn("missing", [], { stdio: ["pipe", "ignore", "ignore"] });
    alone.on("error", () => order.push("alone error"));
    alone.on("close", () => order.push("alone close"));
    alone.stdin!.on("close", () => order.push("alone stdin close"));
    await until(() => order.length === 6);
    expect(order).toEqual([
      "piped error",
      "piped close",
      "piped stdin close",
      "alone error",
      "alone close",
      "alone stdin close",
    ]);
    expect([piped.stdin!.destroyed, alone.stdin!.destroyed]).toEqual([true, true]);
  });

  it("kills a running child, and holds the process open until it exits unless unref'd", async () => {
    fake = createFakeRuntime({ spawn: () => new Promise<number>(() => {}) });
    setRuntime(fake);
    const child = spawn("sleeper", [], { stdio: "ignore" });
    expect(["send", "disconnect"].map((name) => name in child)).toEqual([false, false]);
    expect(fake.refCount).toBe(1);
    child.unref();
    child.unref();
    expect(fake.refCount).toBe(0);
    child.ref();
    child.ref();
    expect(fake.refCount).toBe(1);
    const exit = new Promise<unknown[]>((resolve) => child.on("exit", (...args) => resolve(args)));
    expect([child.kill("SIGINT"), child.killed]).toEqual([true, true]);
    expect(await exit).toEqual([null, "SIGINT"]);
    expect(fake.refCount).toBe(0);
    // Gone: nothing to signal, nothing to hold.
    expect(child.kill()).toBe(false);
    child.ref();
    expect(fake.refCount).toBe(0);
  });

  it("starts a detached child in a process group of its own, which a negative pid reaches", async () => {
    fake = createFakeRuntime({ spawn: () => new Promise<number>(() => {}) });
    setRuntime(fake);
    const requests: (boolean | undefined)[] = [];
    const start = fake.processes.spawn;
    fake.processes.spawn = (request) => {
      requests.push(request.newGroup);
      return start(request);
    };
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const kill = process.kill as (pid: number, signal?: string) => boolean;
    const beside = spawn("beside", [], { stdio: "ignore" });
    const detached = spawn("leader", [], { stdio: "ignore", detached: true });
    expect(requests).toEqual([undefined, true]);
    const exit = new Promise<unknown[]>((resolve) =>
      detached.on("exit", (...args) => resolve(args)),
    );
    // Real Node: process.kill(-child.pid) for a child that is not detached is ESRCH.
    expect(() => kill(-beside.pid!, "SIGTERM")).toThrow("kill ESRCH");
    expect(kill(-detached.pid!, "SIGTERM")).toBe(true);
    expect(await exit).toEqual([null, "SIGTERM"]);
    expect(beside.exitCode).toBeNull();
    beside.kill();
  });
});

describe("a child's output", () => {
  // The README's "a child nobody reads stops after 128 KiB" is its pipe plus
  // what this stream takes at once, without anyone reading it.
  it("is read at once into the stream's buffer, as Node's child sockets do", async () => {
    fake = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("x".repeat(1000));
        return new Promise<number>(() => {});
      },
    });
    setRuntime(fake);
    const child = spawn("writer", [], { stdio: ["ignore", "pipe", "ignore"] });
    await until(() => child.stdout!.readableLength > 0);
    expect(child.stdout!.readableLength).toBe(1000);
    expect(child.stdout!.readableFlowing).toBeNull();
    child.kill();
  });

  // Real Node v26 (and HEAD): with stdio: [first.stdout, 'pipe', 'inherit']
  // the second child reads every line the first wrote; the parent's stream is
  // paused, is not drained when the first child exits, and never closes.
  it("given to another child as its stdin is that child's to read: this process stops reading it", async () => {
    fake = createFakeRuntime({
      spawn: async (request, io) => {
        if (request.command === "writer") {
          for (const line of ["one\n", "two\n", "three\n"]) {
            await sleep(3);
            io.writeStdout(line);
          }
          return 0;
        }
        // Copies its stdin to its stdout until the end.
        for (;;) {
          const chunk = io.readStdin();
          if (chunk === null) {
            return 0;
          }
          io.writeStdout(chunk);
          await sleep(1);
        }
      },
    });
    setRuntime(fake);
    const first = spawn("writer", [], { stdio: ["ignore", "pipe", "ignore"] });
    const second = spawn("copier", [], { stdio: [first.stdout, "pipe", "ignore"] });
    expect([first.stdout!.isPaused(), first.stdout!.readableFlowing]).toEqual([true, false]);
    const events: string[] = [];
    first.on("exit", () => events.push("first exit"));
    first.on("close", () => events.push("first close"));
    first.stdout!.on("end", () => events.push("first.stdout end"));
    let copied = "";
    second.stdout!.on("data", (chunk: Uint8Array) => (copied += String(chunk)));
    await new Promise((resolve) => second.on("close", resolve));
    expect(copied).toBe("one\ntwo\nthree\n");
    expect(first.stdout!.readableLength).toBe(0);
    await sleep(5);
    expect(events).toEqual(["first exit"]);
    expect(fake.refCount).toBe(0);
  });

  it("keeps what this process had read before it gave the stream away, as Node does", async () => {
    let release = () => {};
    fake = createFakeRuntime({
      spawn: async (request, io) => {
        if (request.command === "writer") {
          io.writeStdout("first\n");
          await new Promise<void>((resolve) => (release = resolve));
          io.writeStdout("second\n");
          return 0;
        }
        for (;;) {
          const chunk = io.readStdin();
          if (chunk === null) {
            return 0;
          }
          io.writeStdout(chunk);
          await sleep(1);
        }
      },
    });
    setRuntime(fake);
    const first = spawn("writer", [], { stdio: ["ignore", "pipe", "ignore"] });
    await until(() => first.stdout!.readableLength > 0);
    const second = spawn("copier", [], { stdio: [first.stdout, "pipe", "ignore"] });
    release();
    let copied = "";
    second.stdout!.on("data", (chunk: Uint8Array) => (copied += String(chunk)));
    await new Promise((resolve) => second.on("close", resolve));
    expect(copied).toBe("second\n");
    expect(String(first.stdout!.read())).toBe("first\n");
  });
});

describe("a forked child's messages", () => {
  /** A child with an IPC channel whose other end and exit the test drives. */
  function forked() {
    const { port1, port2 } = new MessageChannel();
    let exit: (status: ExitStatus) => void = () => {};
    fake.processes.spawn = () => ({ pid: 7, stdio: [null, null, null, null], ipc: port1 });
    fake.processes.onExit = (_pid, listener) => {
      exit = (status) => runMacrotask(() => listener(status));
    };
    const child = spawn("node", ["c.js"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const events: string[] = [];
    child.on("message", (message: unknown) => events.push(`message ${String(message)}`));
    child.on("disconnect", () => events.push("disconnect"));
    child.on("exit", (code: unknown, signal: unknown) => events.push(`exit ${code} ${signal}`));
    child.on("close", () => events.push("close"));
    return {
      child,
      events,
      ours: port1,
      theirs: port2,
      exit: (status: ExitStatus) => exit(status),
    };
  }
  const message = (text: string) => ({ type: "message", message: text });

  // Real Node v26, 20 runs of 20: "m1 m2 m3 disconnect exit 0". The exit
  // comes through the kernel and the messages on the channel; here the
  // kernel's report overtakes two of them.
  it("come before 'disconnect' and 'exit' even when the kernel reports the exit first", async () => {
    const { child, events, theirs, exit } = forked();
    theirs.postMessage(message("m1"));
    await until(() => events.length === 1);
    exit({ code: 0, signal: null });
    await sleep(5);
    // Still waiting for what the child sent before it exited.
    expect(events).toEqual(["message m1"]);
    expect([child.exitCode, child.connected, fake.refCount]).toEqual([null, true, 1]);
    theirs.postMessage(message("m2"));
    theirs.postMessage(message("m3"));
    const posted = performance.now();
    postIpcExit(theirs);
    await until(() => events.includes("close"));
    // Emitted as the envelope arrives, not when the wait for it gives up.
    expect(performance.now() - posted).toBeLessThan(500);
    theirs.close();
    expect(events).toEqual([
      "message m1",
      "message m2",
      "message m3",
      "disconnect",
      "exit 0 null",
      "close",
    ]);
    expect([child.exitCode, child.connected, fake.refCount]).toEqual([0, false, 0]);
  });

  // The usual order: the child's last envelope arrives before the kernel's
  // report of its exit. Real Node v26 and Linux emit 'disconnect', 'exit' and
  // 'close' in the same millisecond as the last message.
  it("are all in when the exit envelope came first, so the kernel's report is emitted at once", async () => {
    const { child, events, ours, theirs, exit } = forked();
    // Listens after the child's own listener, so it sees an envelope once the
    // child has.
    const envelopes: string[] = [];
    ours.addEventListener("message", (event: MessageEvent<{ type: string }>) =>
      envelopes.push(event.data.type),
    );
    theirs.postMessage(message("m1"));
    theirs.postMessage(message("m2"));
    postIpcExit(theirs);
    await until(() => envelopes.includes("exit"));
    expect(events).toEqual(["message m1", "message m2"]);
    vi.mocked(nodeSetTimeout).mockClear();
    exit({ code: 0, signal: null });
    // In the kernel's report itself: no timer is armed or waited for.
    expect(nodeSetTimeout).not.toHaveBeenCalled();
    theirs.close();
    expect(events).toEqual(["message m1", "message m2", "disconnect", "exit 0 null", "close"]);
    expect([child.exitCode, child.connected, fake.refCount]).toEqual([0, false, 0]);
  });

  it("end with its disconnect, the last thing a child that closed its channel says", async () => {
    const { events, theirs, exit } = forked();
    exit({ code: 0, signal: null });
    theirs.postMessage(message("m1"));
    theirs.postMessage({ type: "disconnect" });
    await until(() => events.includes("close"));
    theirs.close();
    expect(events).toEqual(["message m1", "disconnect", "exit 0 null", "close"]);
    expect(fake.refCount).toBe(0);
  });

  // Real Node v26 (and Linux): a child that sends and is then killed, by
  // itself or by its parent, gives every message before 'disconnect' and
  // 'exit'. The kernel's report can come before them; they are on the
  // channel already.
  it("that a signal ended still come before 'disconnect' and 'exit'", async () => {
    const { events, theirs, exit } = forked();
    theirs.postMessage(message("m1"));
    theirs.postMessage(message("m2"));
    theirs.postMessage(message("last"));
    exit({ code: null, signal: "SIGKILL" });
    await until(() => events.includes("close"));
    theirs.close();
    expect(events).toEqual([
      "message m1",
      "message m2",
      "message last",
      "disconnect",
      "exit null SIGKILL",
      "close",
    ]);
    expect(fake.refCount).toBe(0);
  });

  it("are not waited for after a signal ended the child, or once this end disconnected", async () => {
    const killed = forked();
    killed.exit({ code: null, signal: "SIGTERM" });
    await until(() => killed.events.includes("close"));
    killed.theirs.close();
    expect(killed.events).toEqual(["disconnect", "exit null SIGTERM", "close"]);

    const closed = forked();
    closed.child.disconnect();
    // The kernel's report comes in a later task, after the disconnect's tick.
    await until(() => closed.events.includes("disconnect"));
    closed.exit({ code: 0, signal: null });
    await until(() => closed.events.includes("close"));
    closed.theirs.close();
    expect(closed.events).toEqual(["disconnect", "exit 0 null", "close"]);
    expect(fake.refCount).toBe(0);
  });

  it("stop being waited for when the child never says it has exited", async () => {
    const { events, theirs, exit } = forked();
    exit({ code: 1, signal: null });
    await sleep(20);
    expect(events).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    theirs.close();
    expect(events).toEqual(["disconnect", "exit 1 null", "close"]);
    expect(fake.refCount).toBe(0);
  });

  // Real Node v26: a second disconnect() emits ERR_IPC_DISCONNECTED at once;
  // a send on the closed channel answers false and fails from a tick.
  it("cannot be answered on a closed channel: send fails and a second disconnect is an 'error'", async () => {
    const { child, events, theirs } = forked();
    child.on("error", (error: { code?: string }) => events.push(`error ${error.code}`));
    runMacrotask(() => {
      child.disconnect();
      child.disconnect();
      events.push("returned");
      expect(child.send("late")).toBe(false);
    });
    await until(() => events.length >= 4);
    theirs.close();
    expect(events).toEqual([
      "error ERR_IPC_DISCONNECTED",
      "returned",
      "disconnect",
      "error ERR_IPC_CHANNEL_CLOSED",
    ]);
  });
});

describe("exec and execFile", () => {
  type Failure = Error & Record<string, unknown>;
  const run = (start: (callback: (...args: unknown[]) => void) => unknown) =>
    new Promise<{ error: Failure | null; stdout: string; stderr: string }>((resolve) =>
      start((error, stdout, stderr) =>
        resolve({ error: error as Failure | null, stdout: String(stdout), stderr: String(stderr) }),
      ),
    );

  // Real Node v26: "RangeError keys=code,cmd code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  // and stdout is exactly maxBuffer long (1000 of 3000).
  it("keep the output up to maxBuffer, end the child and report as Node does", async () => {
    let written = 0;
    fake = createFakeRuntime({
      spawn: async (_request, io) => {
        for (let i = 0; i < 6; i += 1) {
          io.writeStdout("x".repeat(400));
          written += 400;
          await sleep(2);
        }
        return 0;
      },
    });
    setRuntime(fake);
    const { error, stdout } = await run((callback) =>
      exec("writer", { maxBuffer: 1000 }, callback),
    );
    expect(stdout).toBe("x".repeat(1000));
    expect(error).toBeInstanceOf(RangeError);
    expect(error).toMatchObject({
      message: "stdout maxBuffer length exceeded",
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      cmd: "writer",
    });
    expect(Object.keys(error!)).toEqual(["code", "cmd"]);
    // Ended at the chunk that passed the limit, not left to write the rest.
    expect(written).toBeLessThan(2400);
  });

  // Real Node v26: "Error keys=code,killed,signal,cmd code=3 killed=false signal=null".
  it("report a failed command with its code, whether it was killed, its signal and the command", async () => {
    fake = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("out\n");
        io.writeStderr("err\n");
        return 3;
      },
    });
    setRuntime(fake);
    const { error, stdout, stderr } = await run((callback) =>
      execFile("tool", ["a", "b"], callback),
    );
    expect([stdout, stderr]).toEqual(["out\n", "err\n"]);
    expect(Object.keys(error!)).toEqual(["code", "killed", "signal", "cmd"]);
    expect(error).toMatchObject({
      message: "Command failed: tool a b\nerr\n",
      code: 3,
      killed: false,
      signal: null,
      cmd: "tool a b",
    });
  });

  // Real Node v26: "keys=errno,code,syscall,path,spawnargs,cmd ... cmd=\"definitely-not-a-command-xyz a b\"".
  it("name the command on the error of a child that could not start", async () => {
    const { error, stdout, stderr } = await run((callback) =>
      execFile("missing", ["a", "b"], callback),
    );
    expect(error).toMatchObject({
      message: "spawn missing ENOENT",
      code: "ENOENT",
      cmd: "missing a b",
    });
    expect([stdout, stderr]).toEqual(["", ""]);
  });

  it("end the child after `timeout` on the platform's clock, whatever the program made of setTimeout", async () => {
    fake = createFakeRuntime({ spawn: () => new Promise<number>(() => {}) });
    setRuntime(fake);
    const real = globalThis.setTimeout;
    // What a test's fake timers leave: a setTimeout that never fires.
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    let result;
    try {
      result = run((callback) => exec("sleeper", { timeout: 5 }, callback));
    } finally {
      globalThis.setTimeout = real;
    }
    const { error } = await result;
    expect(error).toMatchObject({ killed: true, signal: "SIGTERM", code: null });
  });
});

describe("spawnSync", () => {
  // Real Node v26: keys error,status,signal,output,pid,stdout,stderr with
  // output null, pid 0 and stdout and stderr undefined.
  it("gives a child that could not start no output at all, as Node does", () => {
    const result = spawnSync("missing", ["a"]);
    expect(Object.keys(result)).toEqual([
      "error",
      "status",
      "signal",
      "output",
      "pid",
      "stdout",
      "stderr",
    ]);
    expect(result).toMatchObject({
      status: null,
      signal: null,
      output: null,
      pid: 0,
      stdout: undefined,
      stderr: undefined,
    });
    expect(result.error).toMatchObject({
      message: "spawnSync missing ENOENT",
      code: "ENOENT",
      errno: -2,
      path: "missing",
      spawnargs: ["a"],
    });
    expect(() => execFileSync("missing")).toThrow(
      expect.objectContaining({ code: "ENOENT", output: null, status: null }),
    );
  });

  // Real Node v26: `execSync('seq 1 300000')` throws ENOBUFS (signal SIGTERM)
  // at the default 1 MiB, with errno, path and spawnargs on the error.
  it("limits the output to 1 MiB unless told otherwise, for execSync and execFileSync too", () => {
    const requests: SpawnSyncRequest[] = [];
    fake.processes.spawnSync = (request) => {
      requests.push(request);
      return {
        pid: 9,
        status: { code: null, signal: "SIGTERM" },
        stdout: new Uint8Array(4),
        stderr: new Uint8Array(0),
        error: "ENOBUFS",
      };
    };
    const result = spawnSync("seq", ["1", "300000"]);
    expect(Object.keys(result)).toEqual([
      "error",
      "status",
      "signal",
      "output",
      "pid",
      "stdout",
      "stderr",
    ]);
    expect(result.error).toMatchObject({
      message: "spawnSync seq ENOBUFS",
      code: "ENOBUFS",
      errno: -105,
      syscall: "spawnSync seq",
      path: "seq",
      spawnargs: ["1", "300000"],
    });
    expect(() => execSync("seq 1 300000")).toThrow(
      expect.objectContaining({ code: "ENOBUFS", signal: "SIGTERM", status: null }),
    );
    expect(() => execFileSync("seq", ["1"], { maxBuffer: 10 })).toThrow("spawnSync seq ENOBUFS");
    spawnSync("seq", { maxBuffer: Infinity });
    expect(requests.map((request) => request.maxBuffer)).toEqual([
      1024 * 1024,
      1024 * 1024,
      10,
      Infinity,
    ]);
  });

  // Real Node v26: `execSync("echo out; echo err >&2; exit 2")` prints "err"
  // on the parent's stderr and throws an error whose stderr is "err\n" and
  // whose message is "Command failed: echo out; echo err >&2; exit 2\nerr\n".
  it("execSync and execFileSync capture stderr when the caller chose no stdio, and pass it on", () => {
    const stdio: unknown[] = [];
    fake = createFakeRuntime({
      spawn: (request, io) => {
        stdio.push(request.stdio);
        io.writeStdout("out\n");
        io.writeStderr("err\n");
        return request.args.join(" ").includes("fail") ? 2 : 0;
      },
    });
    setRuntime(fake);
    const passedOn: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      passedOn.push(String(chunk));
      return true;
    });
    try {
      expect(String(execFileSync("tool"))).toBe("out\n");
      let thrown: (Error & { stderr?: unknown; stdout?: unknown; status?: unknown }) | undefined;
      try {
        execSync("tool fail");
      } catch (error) {
        thrown = error as typeof thrown;
      }
      expect(thrown).toMatchObject({ message: "Command failed: tool fail\nerr\n", status: 2 });
      expect([String(thrown?.stdout), String(thrown?.stderr)]).toEqual(["out\n", "err\n"]);
      expect(passedOn).toEqual(["err\n", "err\n"]);
      // A caller that chose its stdio gets what it asked for and nothing is passed on.
      expect(() => execSync("tool fail", { stdio: "pipe" })).toThrow(
        "Command failed: tool fail\nerr\n",
      );
      execFileSync("tool", { stdio: ["ignore", "pipe", "ignore"] });
      expect(passedOn).toHaveLength(2);
      expect(stdio).toEqual([
        ["pipe", "pipe", "pipe"],
        ["pipe", "pipe", "pipe"],
        ["pipe", "pipe", "pipe"],
        ["ignore", "pipe", "ignore"],
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it("reports input the child left as Node does: EPIPE, with its status and output", () => {
    fake.processes.spawnSync = (request) => ({
      pid: 9,
      status: { code: 0, signal: null },
      stdout: new TextEncoder().encode(`${request.command} out`),
      stderr: new Uint8Array(0),
      error: toSystemErrorRecord(createSystemError("EPIPE", "write"))!,
    });
    const result = spawnSync("head", ["-c", "10"], { input: "x".repeat(10) });
    expect(result.error).toMatchObject({
      message: "spawnSync head EPIPE",
      code: "EPIPE",
      errno: -32,
      syscall: "spawnSync head",
      path: "head",
      spawnargs: ["-c", "10"],
    });
    expect([result.status, String(result.stdout)]).toEqual([0, "head out"]);
    // Node names the shell /bin/sh; webnode calls it sh.
    expect(() => execSync("head -c 10", { input: "x" })).toThrow(/^spawnSync (\/bin\/)?sh EPIPE$/);
  });
});

describe("fork", () => {
  it("leaves out the parent's -e/-p code, as Node does, but keeps its other options", () => {
    const requests: { command: string; args: string[] }[] = [];
    fake.processes.spawn = (request) => {
      requests.push(request);
      throw createSystemError("ENOENT", "spawn node", "node");
    };
    const code = 'require("child_process").fork("c.js", ["a"])';
    fake.execArgv = ["--conditions", "dev", "-e", code];
    fork("c.js", ["a"]).on("error", () => {});
    fake.execArgv = ["--print=1", "-r", "./pre.js", "-p", code];
    fork("c.js").on("error", () => {});
    // execArgv given by the caller is used as it is.
    fork("c.js", { execArgv: ["-e", "1"] }).on("error", () => {});
    expect(requests.map((request) => [request.command, ...request.args])).toEqual([
      ["node", "--conditions", "dev", "c.js", "a"],
      ["node", "-r", "./pre.js", "c.js"],
      ["node", "-e", "1", "c.js"],
    ]);
  });
});

// Each order below is what real Node v26 prints for the same program (a
// callback logs itself, then queues a tick ">t" and a promise job ">p").
describe("when the events come, as Node's process.nextTick", () => {
  let order: string[];
  let proc: ReturnType<typeof createProcess>;

  beforeEach(() => {
    fake = createFakeRuntime({ spawn: () => new Promise<number>(() => {}) });
    setRuntime(fake);
    proc = createProcess({ loadBuiltin: () => undefined, ipc: null });
    order = [];
  });

  function mark(tag: string): void {
    order.push(tag);
    proc.nextTick(() => order.push(`${tag}>t`));
    void Promise.resolve().then(() => order.push(`${tag}>p`));
  }

  /** What the caller queues after spawning, in the same macrotask. */
  function callerQueues(): void {
    proc.nextTick(() => order.push("caller>t"));
    void Promise.resolve().then(() => order.push("caller>p"));
  }

  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !done(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  it("emits 'spawn' from a tick (onSpawnNT)", async () => {
    runMacrotask(() => {
      spawn("node", ["-e", ""]).on("spawn", () => mark("spawn"));
      callerQueues();
    });
    await until(() => order.length >= 5);
    expect(order).toEqual(["spawn", "caller>t", "spawn>t", "caller>p", "spawn>p"]);
  });

  it("emits a failed spawn's 'error' from a tick (onErrorNT), and 'close' later", async () => {
    fake.processes.spawn = () => {
      throw createSystemError("ENOENT", "spawn missing", "missing");
    };
    runMacrotask(() => {
      // Its 'close' comes from the event loop, as for a child with output
      // pipes (whose streams end through readable-stream's ticks, which under
      // the test runner are Node's own: test/cases/nexttick-sources.cjs
      // checks that case in a browser).
      const child = spawn("missing", [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.on("error", (error: { code?: string }) => mark(`error ${error.code}`));
      child.on("close", (code: number) => mark(`close ${code}`));
      // As in Node, the exit code is set when 'error' is emitted, not before.
      order.push(`exitCode ${child.exitCode}`);
      callerQueues();
    });
    await until(() => order.length >= 9);
    expect(order).toEqual([
      "exitCode null",
      "error ENOENT",
      "caller>t",
      "error ENOENT>t",
      "caller>p",
      "error ENOENT>p",
      "close -2",
      "close -2>t",
      "close -2>p",
    ]);
  });

  it("emits a failed spawn's 'close' with its 'error' when it has no output pipes", async () => {
    fake.processes.spawn = () => {
      throw createSystemError("ENOENT", "spawn missing", "missing");
    };
    runMacrotask(() => {
      const child = spawn("missing", [], { stdio: "inherit" });
      child.on("error", (error: { code?: string }) => mark(`error ${error.code}`));
      child.on("close", (code: number) => mark(`close ${code}`));
    });
    await until(() => order.length >= 6);
    expect(order).toEqual([
      "error ENOENT",
      "close -2",
      "error ENOENT>t",
      "close -2>t",
      "error ENOENT>p",
      "close -2>p",
    ]);
  });

  it("aborts for a signal already aborted from a tick, after 'spawn'", async () => {
    runMacrotask(() => {
      const controller = new AbortController();
      controller.abort();
      const child = spawn("node", ["-e", ""], { signal: controller.signal });
      child.on("spawn", () => mark("spawn"));
      child.on("error", (error: Error) => mark(`error ${error.name}`));
      proc.nextTick(() => order.push("caller>t"));
    });
    await until(() => order.length >= 7);
    expect(order.slice(0, 7)).toEqual([
      "spawn",
      "error AbortError",
      "caller>t",
      "spawn>t",
      "error AbortError>t",
      "spawn>p",
      "error AbortError>p",
    ]);
  });

  it("calls send's callback and emits 'disconnect' from ticks", async () => {
    const { port1, port2 } = new MessageChannel();
    const posted: unknown[] = [];
    port2.onmessage = (event) => posted.push(event.data);
    fake.processes.spawn = () => ({ pid: 7, stdio: [null, null, null, null], ipc: port1 });
    fake.processes.onExit = () => {};
    runMacrotask(() => {
      const child = spawn("node", ["c.js"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.send("x", (error: Error | null) => mark(`send ${error}`));
      proc.nextTick(() => order.push("caller>t"));
      child.on("disconnect", () => mark("disconnect"));
      child.disconnect();
      child.send("y", (error: { code?: string } | null) => mark(`send closed ${error?.code}`));
      proc.nextTick(() => order.push("caller2>t"));
    });
    await until(() => order.length >= 11 && posted.length >= 2);
    port2.close();
    expect(order).toEqual([
      "send null",
      "caller>t",
      "disconnect",
      "send closed ERR_IPC_CHANNEL_CLOSED",
      "caller2>t",
      "send null>t",
      "disconnect>t",
      "send closed ERR_IPC_CHANNEL_CLOSED>t",
      "send null>p",
      "disconnect>p",
      "send closed ERR_IPC_CHANNEL_CLOSED>p",
    ]);
    expect(posted).toEqual([{ type: "message", message: "x" }, { type: "disconnect" }]);
  });
});

describe("the working directory a child starts in", () => {
  it("is inherited without a cwd option, and changed into with one, as libuv does", () => {
    fake = createFakeRuntime({ cwd: "/work" });
    setRuntime(fake);
    const requests: { cwd: string; inheritCwd?: boolean }[] = [];
    fake.processes.spawn = (request) => {
      requests.push({ cwd: request.cwd, inheritCwd: request.inheritCwd });
      throw createSystemError("ENOENT", "spawn x", "x");
    };
    fake.processes.spawnSync = (request) => {
      requests.push({ cwd: request.cwd, inheritCwd: request.inheritCwd });
      return {
        pid: 9,
        status: { code: 0, signal: null },
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
      };
    };
    spawn("x").on("error", () => {});
    spawn("x", { cwd: null as unknown as string }).on("error", () => {});
    spawn("x", { cwd: "sub" }).on("error", () => {});
    spawnSync("x");
    spawnSync("x", [], { cwd: "/work" });
    execSync("x", { cwd: new URL("file:///tmp") });
    expect(requests).toEqual([
      { cwd: "/work", inheritCwd: true },
      { cwd: "/work", inheritCwd: true },
      { cwd: "/work/sub", inheritCwd: false },
      { cwd: "/work", inheritCwd: true },
      { cwd: "/work", inheritCwd: false },
      { cwd: "/tmp", inheritCwd: false },
    ]);
  });
});

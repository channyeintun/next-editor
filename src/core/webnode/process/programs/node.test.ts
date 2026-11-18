// @vitest-environment node
// The `node` command line over the fake runtime: its options, a worker
// thread's options, `--run`, `-e`'s globals, when the process exits, what an
// uncaught error and an unhandled rejection report, and watch mode wired to
// the process (the supervisor itself is in watch.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import type { ProcessInit } from "../../protocol";
import { resetPackageCaches } from "../loader/modules";
import { BUILTIN_MODULE_NAMES } from "../node/names";
import { THREAD_ERROR_MESSAGE, THREAD_ONLINE_MESSAGE } from "../node/worker_threads";
import { setRuntime } from "../runtime";
import type { SpawnRequest } from "../runtime";
import type { ProcessClient } from "../sysClient";
import { createFakeRuntime, FakeExit, type FakeRuntime } from "../testing/fakeRuntime";
import { createUmaskCell, DEFAULT_UMASK } from "../../umask";
import { runNode } from "./node";
import { TSX_CHILD_OPTION } from "./watchOptions";

// Node's globals would replace the test runner's own `process`, `console` and
// timers; the program reaches its process through require("process") instead.
vi.mock("../node/globals", () => ({ installGlobals: () => globalThis.console }));

// What build/webnodeBundle.ts does to sucrase's code templates in the bundle:
// the code it writes for `import` and `export` uses the loader's own names.
vi.mock("sucrase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sucrase")>();
  return {
    ...actual,
    transform(code: string, options: Parameters<typeof actual.transform>[1]) {
      const result = actual.transform(code, options);
      if (!options.transforms.includes("imports")) {
        return result;
      }
      return {
        ...result,
        code: result.code
          .replaceAll("require('", "__webnode_require('")
          .replace(/(?<!module\.)\bexports\b/g, "__webnode_exports"),
      };
    },
  };
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const SCRIPT_GLOBALS = ["require", "module", "exports", "__filename", "__dirname", "__log"];
const global = globalThis as Record<string, unknown>;
let fake: FakeRuntime;
let events: EventTarget;
let spawned: SpawnRequest[];
/** What a spawned child does: its exit code, or a promise of it. */
let onSpawn: (request: SpawnRequest) => number | Promise<number>;
const log: unknown[] = [];
let saved: Record<string, PropertyDescriptor | undefined>;

beforeEach(() => {
  spawned = [];
  onSpawn = () => 7;
  fake = createFakeRuntime({
    cwd: "/app",
    spawn: (request) => {
      spawned.push(request);
      return onSpawn(request);
    },
  });
  fake.feedStdin(null);
  setRuntime(fake);
  resetPackageCaches();
  log.length = 0;
  // The worker's own events; Node's globalThis is not an EventTarget.
  events = new EventTarget();
  saved = {};
  for (const name of [
    ...SCRIPT_GLOBALS,
    // `-e` and `-p` make each builtin a global.
    ...BUILTIN_MODULE_NAMES,
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
    "__webnodeNativeSetTimeout",
  ]) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }
  global.addEventListener = events.addEventListener.bind(events);
  global.removeEventListener = events.removeEventListener.bind(events);
  global.dispatchEvent = events.dispatchEvent.bind(events);
  global.__log = log;
});

afterEach(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete global[name];
    }
  }
  setRuntime(null);
});

function write(name: string, text: string): void {
  const path = `/app/${name}`;
  fake.fs.mkdir(path.slice(0, path.lastIndexOf("/")), true, 0o755);
  fake.fs.writeFile(path, new TextEncoder().encode(text), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
}

/** Runs `node` with `init` until it exits. */
function run(init: Partial<ProcessInit>): Promise<Result> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error: unknown) => {
      if (!(error instanceof FakeExit)) {
        reject(error);
        return;
      }
      if (!done) {
        done = true;
        resolve({ code: error.code, stdout: fake.stdout(), stderr: fake.stderr() });
      }
    };
    global.__webnodeNativeSetTimeout = (callback: () => void, delay: number) =>
      setTimeout(() => {
        try {
          callback();
        } catch (error) {
          finish(error);
        }
      }, delay);
    const idle: (() => void)[] = [];
    const unref = fake.unref.bind(fake);
    fake.unref = () => {
      unref();
      if (fake.refCount <= 0) {
        for (const listener of idle) {
          listener();
        }
      }
    };
    const client = {
      runtime: fake,
      receive() {},
      onIdle: (listener: () => void) => idle.push(listener),
      refCount: () => fake.refCount,
      ipc: init.ipc ?? null,
    } as unknown as ProcessClient;
    runNode(
      {
        type: "init",
        pid: 1,
        ppid: 0,
        thread: null,
        program: "node",
        argv: ["node"],
        execArgv: [],
        env: { PATH: "/bin" },
        cwd: "/app",
        umask: createUmaskCell(DEFAULT_UMASK),
        syncBuffer: new SharedArrayBuffer(64),
        sharedFs: null,
        ttyFds: [],
        inheritedFds: [],
        terminal: { cols: 80, rows: 24 },
        ipc: null,
        ...init,
      },
      client,
    ).catch(finish);
  });
}

const argv = (...args: string[]) => ({ argv: ["node", ...args] });

describe("options", () => {
  it("continues without a missing --env-file-if-exists file", async () => {
    const result = await run(argv("--env-file-if-exists=.env", "-e", "__log.push('ran')"));
    expect(result).toMatchObject({ code: 0, stderr: ".env not found. Continuing without it.\n" });
    expect(log).toEqual(["ran"]);
  });

  it("still exits 9 for a missing --env-file file", async () => {
    const result = await run(argv("--env-file=.env", "-e", "__log.push('ran')"));
    expect(result).toMatchObject({ code: 9, stderr: "node: .env: not found\n" });
    expect(log).toEqual([]);
  });

  it("reads the value of an option it does not act on, not as the script", async () => {
    write("app.js", "__log.push(require('process').argv.slice(2));");
    const result = await run(
      argv(
        "--disable-warning",
        "ExperimentalWarning",
        "--dns-result-order",
        "ipv4first",
        "app.js",
        "x",
      ),
    );
    expect(result.code).toBe(0);
    expect(log).toEqual([["x"]]);
  });

  it("refuses --watch with --eval", async () => {
    expect(await run(argv("--watch", "-e", "1"))).toMatchObject({
      code: 9,
      stderr: "node: either --watch or --eval can be used, not both\n",
    });
  });
});

describe("a program's IPC channel", () => {
  // nodemon's bus does `if (process.send) { … process.send(…) }`: with a send
  // that exists and throws, it dies at start. Real Node without a channel:
  // "send: undefined connected: undefined" / "after send", exit 0.
  it("is not there unless the process was started with one, so `if (process.send)` tells", async () => {
    write(
      "send.js",
      [
        "const p = require('process');",
        "__log.push([typeof p.send, p.connected, typeof p.disconnect, p.channel]);",
        "if (p.send) { p.send('ready'); }",
        "__log.push('after send');",
      ].join("\n"),
    );
    expect(await run(argv("send.js"))).toMatchObject({ code: 0, stderr: "" });
    expect(log).toEqual([["undefined", undefined, "undefined", undefined], "after send"]);
  });

  it("is the program's when its parent gave it one", async () => {
    write(
      "with-channel.js",
      "const p = require('process'); __log.push([typeof p.send, p.connected, typeof p.channel]); p.send('ready'); p.disconnect();",
    );
    const { port1, port2 } = new MessageChannel();
    const received: unknown[] = [];
    port2.onmessage = (event) => received.push(event.data);
    try {
      expect(await run({ ...argv("with-channel.js"), ipc: port1 })).toMatchObject({
        code: 0,
        stderr: "",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(log).toEqual([["function", true, "object"]]);
      expect(received).toEqual([{ type: "message", message: "ready" }, { type: "disconnect" }]);
    } finally {
      port1.close();
      port2.close();
    }
  });
});

describe("the entry's ticks and promise jobs, with preloads", () => {
  // Each order is what real Node v26 prints for the same code and preloads.
  const code = [
    'import process from "node:process";',
    'process.nextTick(() => __log.push("t"));',
    'Promise.resolve().then(() => __log.push("p"));',
    'queueMicrotask(() => __log.push("q"));',
    '__log.push("sync");',
    "await null;",
    '__log.push("after await");',
    'process.nextTick(() => __log.push("t2"));',
    'Promise.resolve().then(() => __log.push("p2"));',
  ].join(" ");
  const own = ["sync", "p", "q", "after await", "p2"];
  const cases: [string, string[], string[]][] = [
    ["no preload", [], [...own, "t", "t2"]],
    ["a -r preload", ["-r", "./pre.cjs"], ["pre t", "pre p", "pre q", ...own, "t", "t2"]],
    ["an --import preload", ["--import", "./pre.mjs"], ["imp p", ...own, "imp t", "t", "t2"]],
    [
      "both",
      ["-r", "./pre.cjs", "--import", "./pre.mjs"],
      ["pre t", "pre p", "pre q", "imp p", ...own, "imp t", "t", "t2"],
    ],
  ];

  /** Runs `args` in a directory of its own (the loader keeps what this worker loaded). */
  async function runWithPreloads(directory: string, args: string[]): Promise<void> {
    write(
      `${directory}/pre.cjs`,
      'const p = require("process"); p.nextTick(() => __log.push("pre t")); Promise.resolve().then(() => __log.push("pre p")); queueMicrotask(() => __log.push("pre q"));',
    );
    write(
      `${directory}/pre.mjs`,
      'import p from "node:process"; p.nextTick(() => __log.push("imp t")); Promise.resolve().then(() => __log.push("imp p"));',
    );
    write(
      `${directory}/main.cjs`,
      'const p = require("process"); p.nextTick(() => __log.push("t")); Promise.resolve().then(() => __log.push("p")); __log.push("sync");',
    );
    fake.cwd = `/app/${directory}`;
    const result = await run(argv(...args));
    expect(result).toMatchObject({ code: 0, stderr: "", stdout: "" });
  }

  it.each(cases)(
    "-e with --input-type=module runs its ticks after its promise jobs: %s",
    async (label, preloads, want) => {
      await runWithPreloads(`esm-${label.replace(/\W/g, "-")}`, [
        ...preloads,
        "--input-type=module",
        "-e",
        code,
      ]);
      expect(log).toEqual(want);
    },
  );

  const commonJsCases: [string, string[], string[]][] = [
    ["a -r preload", ["-r", "./pre.cjs"], ["sync", "pre t", "t", "pre p", "pre q", "p"]],
    ["an --import preload", ["--import", "./pre.mjs"], ["imp p", "sync", "p", "imp t", "t"]],
    [
      "both",
      ["-r", "./pre.cjs", "--import", "./pre.mjs"],
      ["pre t", "pre p", "pre q", "imp p", "sync", "p", "imp t", "t"],
    ],
  ];

  it.each(commonJsCases)("a CommonJS file entry: %s", async (label, preloads, want) => {
    await runWithPreloads(`cjs-${label.replace(/\W/g, "-")}`, [...preloads, "main.cjs"]);
    expect(log).toEqual(want);
  });
});

describe("--run", () => {
  it("runs a package.json script through the shell from the package's directory", async () => {
    write("package.json", JSON.stringify({ scripts: { hello: "echo hi", other: "true" } }));
    fake.fs.mkdir("/app/sub", true, 0o755);
    fake.cwd = "/app/sub";
    const result = await run(argv("--run", "hello", "ignored", "--", "a b", "c"));
    // The script exited 7: Node's task runner ends with 1 for any failure.
    expect(result.code).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      command: "sh",
      args: ["-c", "echo hi 'a b' c"],
      cwd: "/app",
    });
    expect(spawned[0].env).toMatchObject({
      NODE_RUN_SCRIPT_NAME: "hello",
      NODE_RUN_PACKAGE_JSON_PATH: "/app/package.json",
    });
    expect(spawned[0].env.PATH.split(":")[0]).toBe("/app/node_modules/.bin");
  });

  it("exits 0 when the script exits 0", async () => {
    write("package.json", JSON.stringify({ scripts: { hello: "true" } }));
    onSpawn = () => 0;
    expect((await run(argv("--run", "hello"))).code).toBe(0);
  });

  it("exits 0 when a signal ended the script, and passes none on to it", async () => {
    write("package.json", JSON.stringify({ scripts: { hello: "sleep 5" } }));
    onSpawn = () => new Promise<number>(() => {});
    const pids: number[] = [];
    const spawn = fake.processes.spawn;
    fake.processes.spawn = (request) => {
      const child = spawn(request);
      pids.push(child.pid);
      return child;
    };
    const exited = run(argv("--run", "hello"));
    await waitFor(() => pids.length === 1);
    // A signal for `node` is its own: nothing takes it (the fake records the
    // death and goes on), and the script is not signalled.
    fake.signal("SIGTERM");
    expect(fake.exitCode).toBe(143);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still running: this kill finds it, and its death by signal is no failure.
    fake.processes.kill(pids[0], "SIGTERM");
    expect((await exited).code).toBe(0);
  });

  it("lists the scripts when the one asked for is missing", async () => {
    write("package.json", JSON.stringify({ scripts: { hello: "echo hi" } }));
    expect(await run(argv("--run", "nope"))).toMatchObject({
      code: 1,
      stderr:
        'Missing script: "nope" for /app/package.json\n\nAvailable scripts are:\n  hello: echo hi\n',
    });
    expect(spawned).toEqual([]);
  });
});

describe("-e and -p", () => {
  it("have every builtin module as a global, loaded when first read", async () => {
    // Real Node v26 prints `function function linux|true` for the same line.
    const result = await run(
      argv(
        "-p",
        "[typeof fs.readFileSync, typeof path.join, os.platform()].join(' ') + '|' + (util === require('util'))",
      ),
    );
    expect(result).toMatchObject({ code: 0, stdout: "function function linux|true\n", stderr: "" });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "http")!;
    expect([typeof descriptor.get, typeof descriptor.set, descriptor.enumerable]).toEqual([
      "function",
      "function",
      false,
    ]);
  });

  it("bind the name crypto to node:crypto in a script, and leave the global property alone", async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    // The one-liner of the JWT tutorials; Node prints 16 and false.
    const printed = await run(argv("-p", "crypto.randomBytes(8).toString('hex').length"));
    expect(printed).toMatchObject({ code: 0, stdout: "16\n", stderr: "" });
    const evaluated = await run(
      argv("-e", "__log.push(typeof crypto.randomBytes, globalThis.crypto === require('crypto'))"),
    );
    expect(evaluated).toMatchObject({ code: 0, stderr: "" });
    expect(log).toEqual(["function", false]);
    expect(Object.getOwnPropertyDescriptor(globalThis, "crypto")).toEqual(before);
  });

  it("let a script declare or assign the same names", async () => {
    const result = await run(
      argv(
        "-e",
        "const os = require('os'); var path = require('path'); fs = 5; function util() {} __log.push(typeof os.platform, typeof path.join, fs, typeof util, Object.keys(globalThis).includes('fs'))",
      ),
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    // As real Node v26.
    expect(log).toEqual(["function", "function", 5, "function", true]);
  });

  it("give an ES module the globals too, with crypto still Web Crypto", async () => {
    const result = await run(
      argv(
        "--input-type=module",
        "-e",
        "__log.push(typeof os.platform, typeof fs.readFileSync, typeof crypto.randomBytes)",
      ),
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(log).toEqual(["function", "function", "undefined"]);
  });

  it("-p prints the value once the script's work is done, before its 'exit' listeners", async () => {
    // Real Node v26 prints: tick, promise, timer, { n: 2 }, exit listener.
    const result = await run(
      argv(
        "-p",
        [
          "const process = require('process');",
          "const value = { n: 1 };",
          "process.nextTick(() => __log.push('tick'));",
          "Promise.resolve().then(() => __log.push('promise'));",
          "require('timers').setTimeout(() => { value.n = 2; __log.push('timer'); }, 5);",
          "process.on('exit', () => process.stdout.write('exit listener\\n'));",
          "value",
        ].join(" "),
      ),
    );
    expect(result).toMatchObject({ code: 0, stdout: "{ n: 2 }\nexit listener\n", stderr: "" });
    expect(log).toEqual(["tick", "promise", "timer"]);
  });

  it("-p prints the value at 'exit' when the process ends before a 'beforeExit' reached the print", async () => {
    const result = await run(
      argv("-p", "require('process').on('beforeExit', () => require('process').exit(3)); 'value'"),
    );
    expect(result).toMatchObject({ code: 3, stdout: "value\n" });
  });

  it("are the only ones: a script from stdin has no builtin globals", async () => {
    fake = createFakeRuntime({ cwd: "/app" });
    fake.feedStdin(new TextEncoder().encode("__log.push(typeof os, typeof fs)"));
    fake.feedStdin(null);
    setRuntime(fake);
    const result = await run(argv("-"));
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(log).toEqual(["undefined", "undefined"]);
  });
});

describe("the exit check", () => {
  // Over the fake runtime the worker lives on after the exit, and so would
  // the program: `exited` lets it stop what a real exit ends.
  const program = (body: string) =>
    [
      "const process = require('process');",
      "const timers = require('timers');",
      "let emitted = 0;",
      "let exited = false;",
      "process.on('exit', () => { exited = true; });",
      body,
    ].join("\n");

  it("emits 'beforeExit' again once work a listener started has finished, and exits when one starts none", async () => {
    write(
      "repeat.js",
      program(`process.on('beforeExit', (code) => {
        if (exited) return;
        emitted += 1;
        __log.push('beforeExit ' + emitted + ' ' + code);
        process.nextTick(() => __log.push('tick ' + emitted));
        Promise.resolve().then(() => __log.push('promise ' + emitted));
        if (emitted === 1) timers.setTimeout(() => __log.push('timer'), 3);
        if (emitted === 2) timers.setImmediate(() => __log.push('immediate'));
        if (emitted === 3) require('fs').stat(__filename, () => __log.push('stat'));
        if (emitted > 6) process.exit(9);
      });`),
    );
    expect((await run(argv("repeat.js"))).code).toBe(0);
    // What real Node v26 prints for the same listener.
    expect(log).toEqual([
      "beforeExit 1 0",
      "tick 1",
      "promise 1",
      "timer",
      "beforeExit 2 0",
      "tick 2",
      "promise 2",
      "immediate",
      "beforeExit 3 0",
      "tick 3",
      "promise 3",
      "stat",
      "beforeExit 4 0",
      "tick 4",
      "promise 4",
    ]);
  });

  it("emits it once when a listener starts only work that does not hold the process, and runs none of that work", async () => {
    write(
      "unrefd.js",
      program(`process.on('beforeExit', () => {
        if (exited) return;
        emitted += 1;
        __log.push('beforeExit ' + emitted);
        timers.setImmediate(() => __log.push('unref\\'d immediate')).unref();
        timers.setTimeout(() => __log.push('unref\\'d timer'), 0).unref();
        timers.clearTimeout(timers.setTimeout(() => {}, 1000));
        if (emitted > 3) process.exit(9);
      });`),
    );
    expect((await run(argv("unrefd.js"))).code).toBe(0);
    expect(log).toEqual(["beforeExit 1"]);
    // What was left runs now, in the worker that lives on.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("exits a process whose only work is an unref'd immediate that queues itself again", async () => {
    write(
      "poll.js",
      program(`(function poll() { if (!exited) timers.setImmediate(poll).unref(); })();
      process.on('beforeExit', () => { if (!exited) emitted += 1; });
      const guard = timers.setTimeout(() => { __log.push('still alive'); process.exit(8); }, 500).unref();
      process.on('exit', () => { timers.clearTimeout(guard); __log.push('beforeExit x' + emitted); });`),
    );
    expect((await run(argv("poll.js"))).code).toBe(0);
    expect(log).toEqual(["beforeExit x1"]);
  });
});

describe("an uncaught error", () => {
  it("is printed after the 'exit' listeners have run, as Node does", async () => {
    write(
      "fatal.js",
      [
        "const process = require('process');",
        "process.on('exit', (code) => process.stderr.write('exit listener ' + code + '\\n'));",
        "throw new Error('fatal one');",
      ].join("\n"),
    );
    const result = await run(argv("fatal.js"));
    expect(result.code).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("exit listener 1");
    expect(lines[1]).toBe("Error: fatal one");
  });

  it("is written to fd 2 itself, after what the program wrote there, when its stderr was ended", async () => {
    write(
      "ended.js",
      [
        "const process = require('process');",
        "process.stderr.write('before\\n');",
        "process.stderr.end();",
        "throw new Error('after end');",
      ].join("\n"),
    );
    const result = await run(argv("ended.js"));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^before\n\nError: after end\n/);
    expect(result.stderr).toMatch(/\n\nNode\.js v\d+\.\d+\.\d+\n$/);
  });

  it("is written to fd 2 itself when its stderr was destroyed", async () => {
    write(
      "destroyed.js",
      [
        "const process = require('process');",
        "process.stderr.write('before\\n');",
        "process.stderr.destroy();",
        "throw new Error('after destroy');",
      ].join("\n"),
    );
    const destroyed = await run(argv("destroyed.js"));
    expect(destroyed.code).toBe(1);
    expect(destroyed.stderr).toMatch(/^before\n\nError: after destroy\n/);
  });

  it("is written to fd 2 itself while its stderr is corked, which keeps what it holds, as Node does", async () => {
    write(
      "corked.js",
      [
        "const process = require('process');",
        "process.stderr.write('first\\n');",
        "process.stderr.cork();",
        "process.stderr.write('held\\n');",
        "throw new Error('while corked');",
      ].join("\n"),
    );
    const corked = await run(argv("corked.js"));
    expect(corked.code).toBe(1);
    expect(corked.stderr).toMatch(/^first\n\nError: while corked\n/);
    expect(corked.stderr).not.toContain("held");
  });

  it("ends the process with code 7 when an 'uncaughtException' listener throws, printing that error", async () => {
    write(
      "throws.js",
      [
        "const process = require('process');",
        "process.on('uncaughtException', (error) => { __log.push('listener: ' + error.message); throw new Error('handler threw'); });",
        "process.on('exit', () => __log.push('exit listener'));",
        "throw new Error('first');",
      ].join("\n"),
    );
    const result = await run(argv("throws.js"));
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("Error: handler threw\n    at ");
    expect(result.stderr).toContain("throws.js:2:");
    expect(result.stderr).not.toContain("first");
    // Node runs no 'exit' listener then. (The fake's exit throws, and that
    // error reaches the listener too; a real process is gone by then.)
    expect(log[0]).toBe("listener: first");
    expect(log).not.toContain("exit listener");
  });
});

describe("worker threads", () => {
  it("runs the worker with its argv as arguments and the parent's preloads", async () => {
    write("w.js", "__log.push(require('process').argv.slice(2), globalThis.PRE === 1);");
    write("pre.js", "globalThis.PRE = 1;");
    const { port1, port2 } = new MessageChannel();
    try {
      const result = await run({
        thread: {
          threadId: 1,
          filename: "/app/w.js",
          eval: false,
          workerData: null,
          port: port1,
          name: "",
        },
        argv: ["build", "--version"],
        execArgv: ["-r", "./pre.js"],
      });
      expect(result).toMatchObject({ code: 0, stdout: "" });
      expect(log).toEqual([["build", "--version"], true]);
    } finally {
      port1.close();
      port2.close();
      delete global.PRE;
    }
  });

  /** Runs `source` as a thread and returns what it sent its parent. */
  async function threadMessages(source: string): Promise<{ code: number; received: unknown[] }> {
    write("thread.js", source);
    const { port1, port2 } = new MessageChannel();
    const original = MessagePort.prototype.postMessage;
    const received: unknown[] = [];
    port2.onmessage = (event) => received.push(event.data);
    try {
      const result = await run({
        thread: {
          threadId: 1,
          filename: "/app/thread.js",
          eval: false,
          workerData: null,
          port: port1,
          name: "",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { code: result.code, received };
    } finally {
      MessagePort.prototype.postMessage = original;
      port1.close();
      port2.close();
    }
  }

  it("tells its parent it is online and of an uncaught error, with the error's own properties", async () => {
    const { code, received } = await threadMessages(
      [
        "const error = new RangeError('boom');",
        "error.code = 'E_X'; error.extra = { list: [1, 2] }; error.fn = () => 1;",
        "throw error;",
      ].join("\n"),
    );
    expect(code).toBe(1);
    // The first two: the fake's exit throws where the kernel stops the
    // worker, and that throw is reported as a second error.
    expect(received.slice(0, 2)).toEqual([
      { type: THREAD_ONLINE_MESSAGE },
      {
        type: THREAD_ERROR_MESSAGE,
        thrown: {
          kind: "RangeError",
          name: "RangeError",
          message: "boom",
          stack: expect.stringContaining("RangeError: boom"),
          // Without the one that cannot be cloned.
          own: { code: "E_X", extra: { list: [1, 2] } },
        },
      },
    ]);
  });

  it("is online for its parent whatever the program made of postMessage, which takes its error as in Node", async () => {
    // node: under a spy that does not call through, the Worker emits
    // 'online' and 'exit' and no 'error'.
    const { code, received } = await threadMessages(
      "MessagePort.prototype.postMessage = function () {}; throw new Error('swallowed');",
    );
    expect(code).toBe(1);
    expect(received).toEqual([{ type: THREAD_ONLINE_MESSAGE }]);
  });
});

describe("unhandled rejections", () => {
  it("reach uncaughtException wrapped in ERR_UNHANDLED_REJECTION, with their origin", async () => {
    write(
      "t.js",
      [
        "const process = require('process');",
        "process.on('uncaughtException', (error, origin) => __log.push(typeof error, error.name, error.code, origin, error.message.slice(-24)));",
        "require('timers').setTimeout(() => {}, 30);",
      ].join("\n"),
    );
    const exited = run(argv("t.js"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rejection = (reason: unknown) => {
      // Handled here, so that the test runner does not see it.
      const promise = Promise.reject(reason);
      promise.catch(() => {});
      return Object.assign(new Event("unhandledrejection", { cancelable: true }), {
        reason,
        promise,
      });
    };
    events.dispatchEvent(rejection("str-reason"));
    const error = new Error("real");
    events.dispatchEvent(rejection(error));
    await exited;
    expect(log).toEqual([
      "object",
      "UnhandledPromiseRejection",
      "ERR_UNHANDLED_REJECTION",
      "unhandledRejection",
      'the reason "str-reason".',
      "object",
      "Error",
      undefined,
      "unhandledRejection",
      "real",
    ]);
  });

  let programs = 0;

  /** The browser's report of a rejection nobody handled, or of its late handler. */
  function rejectionEvent(type: string, promise: Promise<unknown>, reason: unknown): Event {
    return Object.assign(new Event(type, { cancelable: true }), { reason, promise });
  }

  /** A rejected promise the test runner does not see as unhandled. */
  function rejected(reason: unknown): Promise<unknown> {
    const promise = Promise.reject(reason);
    promise.catch(() => {});
    return promise;
  }

  /**
   * Runs a program that lives 40 ms under `--unhandled-rejections=<mode>` and
   * has one rejection reported to it. `listeners` are its `process.on` lines.
   * One run per test: the listeners of a program stay on the test's event
   * target after its exit.
   */
  function runMode(mode: string, listeners: string[], reason: unknown): Promise<Result> {
    return startMode(mode, listeners, reason).exited;
  }

  /** `runMode`, for a test that does not wait for the exit. */
  function startMode(
    mode: string,
    listeners: string[],
    reason: unknown,
  ): { exited: Promise<Result>; reported: Promise<void> } {
    // A file of its own: the loader keeps what this worker loaded.
    programs += 1;
    const file = `mode-${programs}.js`;
    write(
      file,
      [
        "const process = require('process');",
        "const timers = require('timers');",
        "const timer = timers.setTimeout(() => __log.push('timer ran'), 40);",
        "process.on('exit', (code) => { timers.clearTimeout(timer); __log.push('exit ' + code); });",
        "process.on('warning', (warning) => __log.push('warning ' + warning.name + ': ' + warning.message.split('\\n')[0].slice(0, 28)));",
        ...listeners,
      ].join("\n"),
    );
    const exited = run(argv(`--unhandled-rejections=${mode}`, file));
    const reported = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
      events.dispatchEvent(rejectionEvent("unhandledrejection", rejected(reason), reason));
    });
    return { exited, reported };
  }

  const onRejection =
    "process.on('unhandledRejection', (reason) => __log.push('UR ' + reason.message));";
  const onUncaught =
    "process.on('uncaughtException', (error, origin) => __log.push('UE ' + error.message + ' ' + origin));";
  const warnings = [
    "warning UnhandledPromiseRejectionWarning: Error: unhandled one",
    "warning UnhandledPromiseRejectionWarning: Unhandled promise rejection.",
  ];
  const failure = () => new Error("unhandled one");

  // Each expectation is what real Node v26 does for the same program and mode.
  it("warn: emits 'unhandledRejection', warns twice whether or not it was listened to, and goes on", async () => {
    const result = await runMode("warn", [onRejection], failure());
    expect(result.code).toBe(0);
    expect(log).toEqual(["UR unhandled one", ...warnings, "timer ran", "exit 0"]);
    expect(result.stderr.split("\n")[0]).toBe(
      "(node:1) UnhandledPromiseRejectionWarning: Error: unhandled one",
    );
    expect(result.stderr).toContain(
      "(node:1) UnhandledPromiseRejectionWarning: Unhandled promise rejection. This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). To terminate the node process on unhandled promise rejection, use the CLI flag `--unhandled-rejections=strict` (see https://nodejs.org/api/cli.html#cli_unhandled_rejections_mode). (rejection id: 1)\n",
    );
  });

  it("warn: names a reason that is no error", async () => {
    const result = await runMode("warn", [], 42);
    expect(result.code).toBe(0);
    expect(result.stderr.split("\n")[0]).toBe("(node:1) UnhandledPromiseRejectionWarning: 42");
  });

  it("none: without a listener, nothing happens", async () => {
    expect(await runMode("none", [], failure())).toMatchObject({ code: 0, stderr: "" });
    expect(log).toEqual(["timer ran", "exit 0"]);
  });

  it("none: emits 'unhandledRejection'", async () => {
    expect(await runMode("none", [onRejection], failure())).toMatchObject({ code: 0, stderr: "" });
    expect(log).toEqual(["UR unhandled one", "timer ran", "exit 0"]);
  });

  it("warn-with-error-code: warns and sets the exit code when nothing listened", async () => {
    expect((await runMode("warn-with-error-code", [], failure())).code).toBe(1);
    expect(log).toEqual([...warnings, "timer ran", "exit 1"]);
  });

  it("warn-with-error-code: a listener takes it, with no warning and no exit code", async () => {
    const result = await runMode("warn-with-error-code", [onRejection], failure());
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(log).toEqual(["UR unhandled one", "timer ran", "exit 0"]);
  });

  it("strict: raises an uncaught exception even with an 'unhandledRejection' listener", async () => {
    // The process ends inside the browser's event: record the exit instead of throwing there.
    const exit = recordExit();
    await startMode("strict", [onRejection], failure()).reported;
    expect(exit.code).toBe(1);
    expect(fake.stderr()).toContain("Error: unhandled one");
    // Before any 'unhandledRejection': a real process is gone by then.
    expect(log[0]).toBe("exit 1");
  });

  it("strict: once 'uncaughtException' took it, emits 'unhandledRejection'", async () => {
    await runMode("strict", [onRejection, onUncaught], failure());
    expect(log).toEqual([
      "UE unhandled one unhandledRejection",
      "UR unhandled one",
      "timer ran",
      "exit 0",
    ]);
  });

  it("strict: once 'uncaughtException' took it and nothing listens for the rejection, warns", async () => {
    await runMode("strict", [onUncaught], failure());
    expect(log).toEqual([
      "UE unhandled one unhandledRejection",
      ...warnings,
      "timer ran",
      "exit 0",
    ]);
  });

  it("throw, the default: an 'unhandledRejection' listener takes it", async () => {
    await runMode("throw", [onRejection, onUncaught], failure());
    expect(log).toEqual(["UR unhandled one", "timer ran", "exit 0"]);
  });

  it("refuses a mode Node does not know", async () => {
    expect(await run(argv("--unhandled-rejections=loud", "-e", "__log.push('ran')"))).toMatchObject(
      {
        code: 9,
        stderr: "node: invalid value for --unhandled-rejections\n",
      },
    );
    expect(log).toEqual([]);
  });

  /** Runs a program whose one rejection is reported, then handled. */
  async function runHandledLate(listener: string): Promise<void> {
    programs += 1;
    write(
      `late-${programs}.js`,
      [
        "const process = require('process');",
        "process.on('unhandledRejection', () => {});",
        "process.on('warning', (warning) => __log.push(warning.name + ': ' + warning.message));",
        listener,
        "require('timers').setTimeout(() => {}, 40);",
      ].join("\n"),
    );
    const exited = run(argv(`late-${programs}.js`));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reason = new Error("late");
    const promise = rejected(reason);
    events.dispatchEvent(rejectionEvent("unhandledrejection", promise, reason));
    events.dispatchEvent(rejectionEvent("rejectionhandled", promise, reason));
    await exited;
  }

  it("warns that a reported rejection was handled later", async () => {
    await runHandledLate("");
    expect(log).toEqual([
      "PromiseRejectionHandledWarning: Promise rejection was handled asynchronously (rejection id: 1)",
    ]);
  });

  it("emits 'rejectionHandled' instead of that warning when it is listened to", async () => {
    await runHandledLate("process.on('rejectionHandled', () => __log.push('RH'));");
    expect(log).toEqual(["RH"]);
  });
});

/**
 * The supervisor exits from a promise job, where the fake's throwing exit
 * would be an unhandled rejection: record the code instead.
 */
function recordExit(): { code: number | null } {
  const exit = { code: null as number | null };
  fake.processes.exit = ((code: number) => {
    exit.code = code;
  }) as typeof fake.processes.exit;
  return exit;
}

/** Waits until `condition` holds, failing after 3 s. */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("watch mode", () => {
  it("supervises the program in a child node and restarts it on a change", async () => {
    write("app.js", "__log.push('ran in the supervisor');");
    // The first run ends at once; the second keeps running.
    onSpawn = () => (spawned.length === 1 ? 0 : new Promise<number>(() => {}));
    void run(argv("--watch-path=.", "--watch-preserve-output", "app.js", "x"));
    await waitFor(() => fake.stdout().includes("Completed running"));
    expect(spawned[0]).toMatchObject({
      command: "/bin/node",
      args: ["--watch-preserve-output", "app.js", "x"],
      cwd: "/app",
      stdio: ["inherit", "inherit", "inherit"],
    });
    expect(spawned[0].env.WATCH_REPORT_DEPENDENCIES).toBe("1");
    expect(fake.stdout()).toBe(
      "Completed running 'app.js x'. Waiting for file changes before restarting...\n",
    );
    write("notes.txt", "x");
    await waitFor(() => spawned.length === 2);
    expect(fake.stdout()).toContain("Change detected in '/app/notes.txt'\nRestarting 'app.js x'\n");
    const exit = recordExit();
    fake.signal("SIGTERM");
    // The child ended by the signal has no code: the supervisor exits 0.
    await waitFor(() => exit.code !== null);
    expect(exit.code).toBe(0);
    expect(log).toEqual([]);
  });

  it("leaves --env-file's variables to the program it supervises", async () => {
    write(".env", "FOO=one");
    write("app.js", "");
    onSpawn = () => new Promise<number>(() => {});
    void run(argv("--watch-path=.", "--env-file=.env", "app.js"));
    await waitFor(() => spawned.length === 1);
    expect(spawned[0].env.FOO).toBeUndefined();
    expect(spawned[0].args).toEqual(["--env-file=.env", "app.js"]);
    const exit = recordExit();
    fake.signal("SIGINT");
    await waitFor(() => exit.code !== null);
    expect(exit.code).toBe(0);
  });

  it("still requires an --env-file that is not there", async () => {
    expect(await run(argv("--watch", "--env-file=gone.env", "app.js"))).toMatchObject({
      code: 9,
      stderr: "node: gone.env: not found\n",
    });
  });

  it("refuses --watch-path with --eval, and runs --run once", async () => {
    expect(await run(argv("--watch-path=.", "-e", "1"))).toMatchObject({
      code: 9,
      stderr: "node: either --watch or --eval can be used, not both\n",
    });
    write("package.json", JSON.stringify({ scripts: { hello: "echo hi" } }));
    expect((await run(argv("--watch", "--run", "hello"))).code).toBe(1);
    expect(spawned.map((request) => request.args)).toEqual([["-c", "echo hi"]]);
  });

  it("in the child, reports each file loaded, and what a failed require looked for", async () => {
    write(
      "reporting.js",
      "require('./dep.js'); try { require('./later') } catch {} require('./dep.js');",
    );
    write("dep.js", "");
    const { port1, port2 } = new MessageChannel();
    const received: unknown[] = [];
    port2.onmessage = (event) => received.push(event.data);
    try {
      fake.env.WATCH_REPORT_DEPENDENCIES = "1";
      const result = await run({ ...argv("reporting.js"), ipc: port1 });
      expect(result.code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const files = received.map(
        (data) => (data as { message: { "watch:require": string[] } }).message["watch:require"][0],
      );
      expect(files.slice(0, 4)).toEqual([
        "/app/reporting.js",
        "/app/dep.js",
        "/app/later",
        "/app/later.js",
      ]);
      expect(new Set(files).size).toBe(files.length);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("in the child, reports where it looked for a script that is not there", async () => {
    // Creating the script then restarts the program: `node --watch later.js`.
    const { port1, port2 } = new MessageChannel();
    const received: unknown[] = [];
    port2.onmessage = (event) => received.push(event.data);
    try {
      fake.env.WATCH_REPORT_DEPENDENCIES = "1";
      const result = await run({ ...argv("later.js"), ipc: port1 });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Cannot find module '/app/later.js'");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const files = received.flatMap(
        (data) => (data as { message: { "watch:require": string[] } }).message["watch:require"],
      );
      expect(files).toContain("/app/later.js");
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("runs a thread's file in the thread, though the thread has the process's --watch", async () => {
    // A Worker gets the process's execArgv: only the process supervises.
    write("in-thread.js", "__log.push('ran in the thread');");
    const { port1, port2 } = new MessageChannel();
    try {
      const result = await run({
        thread: {
          threadId: 1,
          filename: "/app/in-thread.js",
          eval: false,
          workerData: null,
          port: port1,
          name: "",
        },
        argv: [],
        execArgv: ["--watch"],
      });
      expect(result).toMatchObject({ code: 0, stdout: "" });
      expect(log).toEqual(["ran in the thread"]);
      expect(spawned).toEqual([]);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("under tsx watch, the child reports over a channel the program does not get", async () => {
    // Real tsx 4: `send: undefined connected: undefined channel: undefined`.
    write(
      "under-tsx.js",
      "const p = require('process'); __log.push(typeof p.send, p.connected, p.channel, p.execArgv);",
    );
    const { port1, port2 } = new MessageChannel();
    const received: unknown[] = [];
    port2.onmessage = (event) => received.push(event.data);
    try {
      const result = await run({
        argv: ["node", TSX_CHILD_OPTION, "--no-warnings", "under-tsx.js"],
        ipc: port1,
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(log).toEqual(["undefined", undefined, undefined, ["--no-warnings"]]);
      expect(received).toEqual([
        { type: "message", message: { type: "dependency", path: "/app/under-tsx.js" } },
      ]);
    } finally {
      port1.close();
      port2.close();
    }
  });
});

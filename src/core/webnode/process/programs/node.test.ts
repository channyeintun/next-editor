// @vitest-environment node
// The `node` command line over the fake runtime: its options, a worker
// thread's options, `--run`, and what an unhandled rejection reports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import type { ProcessInit } from "../../protocol";
import { resetPackageCaches } from "../loader/modules";
import { setRuntime } from "../runtime";
import type { SpawnRequest } from "../runtime";
import type { ProcessClient } from "../sysClient";
import { createFakeRuntime, FakeExit, type FakeRuntime } from "../testing/fakeRuntime";
import { runNode } from "./node";

// Node's globals would replace the test runner's own `process`, `console` and
// timers; the program reaches its process through require("process") instead.
vi.mock("../node/globals", () => ({ installGlobals: () => globalThis.console }));

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
const log: unknown[] = [];
let saved: Record<string, PropertyDescriptor | undefined>;

beforeEach(() => {
  spawned = [];
  fake = createFakeRuntime({
    cwd: "/app",
    spawn: (request) => {
      spawned.push(request);
      return 7;
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
      ipc: null,
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
        syncBuffer: new SharedArrayBuffer(64),
        sharedFs: null,
        ttyFds: [],
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

  it("says --watch does not restart a script, and runs it", async () => {
    write("watched.js", "__log.push('ran');");
    const result = await run(argv("--watch", "watched.js"));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("--watch is not supported in webnode");
    expect(log).toEqual(["ran"]);
  });
});

describe("--run", () => {
  it("runs a package.json script through the shell from the package's directory", async () => {
    write("package.json", JSON.stringify({ scripts: { hello: "echo hi", other: "true" } }));
    fake.fs.mkdir("/app/sub", true, 0o755);
    fake.cwd = "/app/sub";
    const result = await run(argv("--run", "hello", "ignored", "--", "a b", "c"));
    expect(result.code).toBe(7);
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
    const rejection = (reason: unknown) =>
      Object.assign(new Event("unhandledrejection", { cancelable: true }), {
        reason,
        promise: null,
      });
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
});

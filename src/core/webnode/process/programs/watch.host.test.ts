// @vitest-environment node
// The watch supervisor's host over a real process object and the fake
// runtime: what the supervisor is wired to in a node process (the supervisor
// itself, over a fake host, is in watch.test.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { createProcess } from "../node/process";
import type { NodeProcess } from "../node/process";
import { setRuntime } from "../runtime";
import type { SpawnRequest } from "../runtime";
import { createFakeRuntime, FakeExit, type FakeRuntime } from "../testing/fakeRuntime";
import { processWatchHost, runWatchSupervisor } from "./watch";
import type { SupervisedChild, WatchHost } from "./watch";

let fake: FakeRuntime;
let spawned: SpawnRequest[];
let process: NodeProcess;
let host: WatchHost;

beforeEach(() => {
  spawned = [];
  fake = createFakeRuntime({
    cwd: "/app",
    env: { PATH: "/bin" },
    spawn: (request) => {
      spawned.push(request);
      return new Promise<number>(() => {});
    },
  });
  fake.vfs.mkdir("/app/src", true, 0o755);
  setRuntime(fake);
  process = createProcess({ loadBuiltin: () => undefined, ipc: null });
  host = processWatchHost(process);
});

afterEach(() => {
  setRuntime(null);
});

function write(path: string, text = ""): void {
  fake.fs.writeFile(path, new TextEncoder().encode(text), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
}

/** Lets the event loop turn until `done()` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(done()).toBe(true);
}

describe("the supervisor's host in a node process", () => {
  it("tells a folder from a file, following links, and says null for nothing", () => {
    write("/app/src/server.ts");
    fake.fs.symlink("/app/src", "/app/link");
    fake.fs.symlink("/app/src/server.ts", "/app/file-link");
    fake.fs.symlink("/app/gone", "/app/dangling");
    expect(
      ["/app/src", "/app/src/server.ts", "/app/link", "/app/file-link", "/app/gone"].map(host.kind),
    ).toEqual(["directory", "file", "directory", "file", null]);
    expect(host.kind("/app/dangling")).toBeNull();
  });

  it("hears what is typed on standard input", async () => {
    let heard = 0;
    host.onInput(() => {
      heard += 1;
    });
    fake.feedStdin("\n");
    await until(() => heard > 0);
    expect(heard).toBe(1);
  });

  it("exits with the code it is given", () => {
    expect(() => host.exit(3)).toThrow(FakeExit);
    expect(fake.exitCode).toBe(3);
  });

  it("holds the process open with its watchers, and with a timer only when asked to", async () => {
    const before = fake.refCount;
    const events: string[] = [];
    const watcher = host.watch("/app/src", false, (eventType, filename) => {
      events.push(`${eventType} ${filename}`);
    });
    expect(fake.refCount).toBe(before + 1);
    write("/app/src/new.ts", "x");
    await until(() => events.length > 0);
    expect(events[0]).toBe("rename new.ts");
    watcher.clear();
    await until(() => fake.refCount === before);
    expect(() => host.watch("/app/gone", false, () => {})).toThrow(/ENOENT/);

    let fired = 0;
    const idle = host.setTimer(() => (fired += 1), 1, false);
    expect(fake.refCount).toBe(before);
    const held = host.setTimer(() => (fired += 1), 1, true);
    expect(fake.refCount).toBe(before + 1);
    await until(() => fired === 2);
    expect(fake.refCount).toBe(before);
    idle.clear();
    held.clear();
    const cleared = host.setTimer(() => (fired += 1), 1, true);
    cleared.clear();
    expect(fake.refCount).toBe(before);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toBe(2);
  });

  it("writes to standard output and standard error, and starts node on its own stdio", async () => {
    host.write("out\n");
    host.writeError("err\n");
    expect(fake.stdout()).toBe("out\n");
    expect(fake.stderr()).toBe("err\n");
    expect(host.parent).toBeNull();
    host.spawnNode(["--no-warnings", "app.js"], { ipc: false, env: { PATH: "/bin", X: "1" } });
    await until(() => spawned.length === 1);
    expect(spawned[0]).toMatchObject({
      command: process.execPath,
      args: ["--no-warnings", "app.js"],
      stdio: ["inherit", "inherit", "inherit"],
      env: { PATH: "/bin", X: "1" },
    });
  });
});

describe("tsx watch in a node process", () => {
  const tsx = {
    include: ["views"],
    exclude: [],
    clearScreen: false,
    noCache: false,
    tsconfig: null,
  };
  const config = {
    execArgv: [],
    command: ["src/server.ts"],
    script: "src/server.ts",
    watchPaths: [],
    preserveOutput: false,
    killSignal: null,
    envFiles: [],
    nodeOptions: null,
    tsx,
  };

  /** A program that runs until it is killed (the fake runtime starts none with an IPC channel). */
  function program(): SupervisedChild {
    const exits: ((code: number | null, signal: string | null) => void)[] = [];
    let killed = false;
    return {
      get killed() {
        return killed;
      },
      kill(signal) {
        killed = true;
        queueMicrotask(() => {
          for (const listener of exits) {
            listener(null, signal);
          }
        });
        return true;
      },
      send: () => true,
      on(event, listener) {
        if (event === "exit") {
          exits.push(listener as (code: number | null, signal: string | null) => void);
        }
      },
      off() {},
    };
  }

  it("reruns on Enter, and names a new folder under --include as chokidar does", async () => {
    write("/app/src/server.ts");
    fake.vfs.mkdir("/app/views", true, 0o755);
    let runs = 0;
    runWatchSupervisor(config, {
      ...host,
      spawnNode: () => {
        runs += 1;
        return program();
      },
    });
    expect(runs).toBe(1);
    fake.feedStdin("\n");
    await until(() => runs === 2);
    expect(fake.stdout()).toMatch(/ \[tsx\] Return key Restarting\.\.\.\n$/);
    fake.vfs.mkdir("/app/views/partials", true, 0o755);
    await until(() => runs === 3);
    expect(fake.stdout()).toMatch(/ \[tsx\] addDir in \.\/views\/partials Restarting\.\.\.\n$/);
  });

  it("with no script prints tsx's error and usage on the process's streams and exits 1", () => {
    expect(() => runWatchSupervisor({ ...config, command: [], script: null }, host)).toThrow(
      FakeExit,
    );
    expect(fake.exitCode).toBe(1);
    expect(fake.stderr()).toBe('Error: Missing required parameter "script path"\n\n');
    expect(fake.stdout()).toMatch(/^tsx watch\n\nRun the script and watch for changes\n\nUSAGE:\n/);
    expect(spawned).toEqual([]);
  });
});

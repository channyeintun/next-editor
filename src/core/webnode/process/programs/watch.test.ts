// @vitest-environment node
// Watch mode's supervisor over a fake host (a manual clock, fake children and
// fake watchers): `node --watch` as Node v26's watch_mode.js behaves on Linux,
// `tsx watch` as tsx 4's watch command does, and the child's reports.
import { describe, expect, it } from "vitest";
import { runWatchSupervisor, watchReporter } from "./watch";
import type { SupervisedChild, Timer, WatchConfig, WatchHost } from "./watch";
import type { NodeProcess } from "../node/process";
import type { TsxWatchSettings } from "./watchOptions";
import { TSX_CHILD_OPTION } from "./watchOptions";

type Listener = (...args: unknown[]) => void;

class FakeChild implements SupervisedChild {
  readonly args: string[];
  readonly options: { ipc: boolean; env: Record<string, string | undefined> };
  killed = false;
  exited = false;
  readonly signals: string[] = [];
  readonly sent: unknown[] = [];
  readonly #listeners: Record<string, Listener[]> = { exit: [], message: [] };
  /** Ends at once on a kill, unless the test ends it. */
  endsOnKill = true;

  constructor(args: string[], options: { ipc: boolean; env: Record<string, string | undefined> }) {
    this.args = args;
    this.options = options;
  }

  on(event: "exit" | "message", listener: (...args: never[]) => void): this {
    this.#listeners[event].push(listener as Listener);
    return this;
  }

  off(event: "message", listener: (...args: never[]) => void): this {
    this.#listeners[event] = this.#listeners[event].filter((each) => each !== listener);
    return this;
  }

  kill(signal: string): boolean {
    if (this.exited) {
      return false;
    }
    this.signals.push(signal);
    this.killed = true;
    if (this.endsOnKill) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const listener of this.#listeners.exit.slice()) {
      listener(code, signal);
    }
  }

  report(message: unknown): void {
    for (const listener of this.#listeners.message.slice()) {
      listener(message);
    }
  }
}

interface FakeWatch {
  target: string;
  recursive: boolean;
  listener: (eventType: string, filename: string | null) => void;
  closed: boolean;
}

function fakeHost(options: Partial<WatchHost> = {}) {
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void; keepAlive: boolean }>();
  const watches: FakeWatch[] = [];
  const kinds = new Map<string, "file" | "directory">([["/", "directory"]]);
  const children: FakeChild[] = [];
  const signals = new Map<string, () => void>();
  const state = {
    output: "",
    errors: "",
    exitCode: null as number | null,
    input: null as (() => void) | null,
  };

  const host: WatchHost = {
    cwd: "/app",
    env: { PATH: "/bin" },
    spawnNode(args, spawnOptions) {
      const child = new FakeChild(args, spawnOptions);
      children.push(child);
      return child;
    },
    watch(target, recursive, listener) {
      if (!kinds.has(target)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${target}'`), {
          code: "ENOENT",
        });
      }
      const watched: FakeWatch = { target, recursive, listener, closed: false };
      watches.push(watched);
      return {
        clear: () => {
          watched.closed = true;
        },
      };
    },
    kind: (target) => kinds.get(target) ?? null,
    entries: (target) =>
      [...kinds.keys()]
        .filter((path) => path !== target && path.slice(0, path.lastIndexOf("/") || 1) === target)
        .map((path) => ({ name: path.slice(path.lastIndexOf("/") + 1), link: false })),
    setTimer(callback, ms, keepAlive): Timer {
      const timer = { at: now + ms, callback, keepAlive };
      timers.add(timer);
      return { clear: () => timers.delete(timer) };
    },
    write(text) {
      state.output += text;
    },
    writeError(text) {
      state.errors += text;
    },
    onSignal(signal, handler) {
      signals.set(signal, handler);
    },
    exit(code) {
      state.exitCode = code;
    },
    parent: null,
    onInput(listener) {
      state.input = listener;
    },
    nodeColors: false,
    tsxColors: false,
    environmentColors: false,
    stdoutIsTTY: false,
    timeOfDay: () => "10:00:00 AM",
    ...options,
  };

  const flush = async () => {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  };

  /** Creates `path` (and its folders) in the fake tree. */
  const file = (path: string, kind: "file" | "directory" = "file") => {
    kinds.set(path, kind);
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      kinds.set(path.slice(0, at), "directory");
    }
  };

  return {
    host,
    children,
    watches,
    state,
    file,
    remove: (path: string) => kinds.delete(path),
    /** What the watchers of `path` hear: an fs.watch event for it. */
    change(path: string, eventType = "change") {
      for (const watched of watches) {
        if (watched.closed) {
          continue;
        }
        const prefix = watched.target === "/" ? "/" : `${watched.target}/`;
        let name: string | null = null;
        if (path === watched.target) {
          name = path.slice(path.lastIndexOf("/") + 1);
        } else if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          if (watched.recursive || !rest.includes("/")) {
            name = rest;
          }
        }
        if (name !== null) {
          watched.listener(eventType, name);
        }
      }
    },
    /** Moves the clock on by `ms`, running the timers that come due and the promise jobs after each. */
    async tick(ms: number) {
      const until = now + ms;
      await flush();
      for (;;) {
        const due = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) {
          break;
        }
        timers.delete(due);
        now = due.at;
        due.callback();
        await flush();
      }
      now = until;
      await flush();
    },
    signal: async (name: string) => {
      signals.get(name)?.();
      await flush();
    },
    openWatches: () =>
      watches.filter((watched) => !watched.closed).map((watched) => watched.target),
  };
}

function config(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return {
    execArgv: ["--watch"],
    command: ["server.js"],
    script: "server.js",
    watchPaths: [],
    preserveOutput: false,
    killSignal: null,
    envFiles: [],
    nodeOptions: null,
    tsx: null,
    ...overrides,
  };
}

const WAITING = "Waiting for file changes before restarting...";

describe("node --watch", () => {
  it("runs the program in a child with the watch options removed and the reports asked for", () => {
    const fake = fakeHost();
    runWatchSupervisor(
      config({
        execArgv: [
          "--watch",
          "--watch-path",
          "src",
          "--watch_path=lib",
          "--watch-preserve-output",
          "--env-file=.env",
          "--watch=true",
        ],
        command: ["server.js", "--port", "3"],
        watchPaths: [],
        nodeOptions: [
          "--watch",
          "--max-old-space-size=100",
          "--watch-kill-signal",
          "SIGINT",
          "-r",
          "a b",
        ],
      }),
      fake.host,
    );
    expect(fake.children).toHaveLength(1);
    const [child] = fake.children;
    // As Node's loop: --watch-path and its value go, --watch-preserve-output stays.
    expect(child.args).toEqual([
      "--watch-preserve-output",
      "--env-file=.env",
      "server.js",
      "--port",
      "3",
    ]);
    expect(child.options).toEqual({
      ipc: true,
      env: {
        PATH: "/bin",
        WATCH_REPORT_DEPENDENCIES: "1",
        NODE_OPTIONS: '--max-old-space-size=100 -r "a b"',
      },
    });
  });

  it("restarts on a change to a file the child loaded, after the burst settles", async () => {
    const fake = fakeHost();
    fake.file("/app/server.js");
    fake.file("/app/lib/dep.js");
    fake.file("/app/notes.txt");
    runWatchSupervisor(config(), fake.host);
    const first = fake.children[0];
    first.report({ "watch:require": ["/app/server.js"] });
    first.report({ "watch:import": ["file:///app/lib/dep.js"] });
    // Each file is watched through its folder, not recursively.
    expect(fake.openWatches()).toEqual(["/app", "/app/lib"]);
    expect(fake.watches.every((watched) => !watched.recursive)).toBe(true);

    // A file in a watched folder that the child did not load changes nothing.
    fake.change("/app/notes.txt");
    await fake.tick(1000);
    expect(fake.children).toHaveLength(1);

    fake.change("/app/server.js");
    await fake.tick(150);
    fake.change("/app/lib/dep.js", "rename");
    await fake.tick(150);
    // 200 ms after the last change, not the first.
    expect(first.signals).toEqual([]);
    await fake.tick(100);
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toBe(
      "Change detected in '/app/lib/dep.js'\nRestarting 'server.js'\n",
    );
  });

  it("says how each run ended, and reruns a crashed program on the next change", async () => {
    const fake = fakeHost();
    fake.file("/app/server.js");
    runWatchSupervisor(config(), fake.host);
    fake.children[0].report({ "watch:require": ["/app/server.js"] });
    fake.children[0].exit(1);
    await fake.tick(0);
    expect(fake.state.output).toBe(`Failed running 'server.js'. ${WAITING}\n`);
    fake.change("/app/server.js");
    await fake.tick(200);
    // An exited child is not killed again.
    expect(fake.children[0].signals).toEqual([]);
    expect(fake.children).toHaveLength(2);
    fake.children[1].exit(0);
    await fake.tick(0);
    expect(fake.state.output).toBe(
      `Failed running 'server.js'. ${WAITING}\n` +
        "Change detected in '/app/server.js'\nRestarting 'server.js'\n" +
        `Completed running 'server.js'. ${WAITING}\n`,
    );
  });

  it("forgets the old child's files: only what the new child loads restarts it", async () => {
    const fake = fakeHost();
    fake.file("/app/server.js");
    fake.file("/app/old.js");
    runWatchSupervisor(config(), fake.host);
    fake.children[0].report({ "watch:require": ["/app/server.js"] });
    fake.children[0].report({ "watch:require": ["/app/old.js"] });
    fake.change("/app/server.js");
    await fake.tick(200);
    fake.children[1].report({ "watch:require": ["/app/server.js"] });
    fake.change("/app/old.js");
    await fake.tick(500);
    expect(fake.children).toHaveLength(2);
  });

  it("starts the next child only once the last has exited, and reports a slow stop", async () => {
    const fake = fakeHost({ nodeColors: true });
    fake.file("/app/server.js");
    runWatchSupervisor(config({ command: ["server.js", "a b"] }), fake.host);
    const first = fake.children[0];
    first.endsOnKill = false;
    first.report({ "watch:require": ["/app/server.js"] });
    fake.change("/app/server.js");
    await fake.tick(200);
    expect(first.signals).toEqual(["SIGTERM"]);
    await fake.tick(499);
    expect(fake.children).toHaveLength(1);
    await fake.tick(1);
    // A change while it stops is dropped.
    fake.change("/app/server.js");
    await fake.tick(300);
    first.exit(0);
    await fake.tick(0);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toBe(
      "\x1bc\x1b[34mChange detected in '/app/server.js'\x1b[39m\n" +
        "\x1b[32mRestarting 'server.js a b'\x1b[39m\n" +
        "\x1b[34mWaiting for graceful termination...\x1b[39m\n" +
        "\x1bc\x1b[32mGracefully restarted 'server.js a b'\x1b[39m\n",
    );
    await fake.tick(1000);
    expect(fake.children).toHaveLength(2);
  });

  it("keeps the output with --watch-preserve-output, and kills with --watch-kill-signal", async () => {
    const fake = fakeHost({ nodeColors: true });
    fake.file("/app/server.js");
    runWatchSupervisor(config({ preserveOutput: true, killSignal: "sigint" }), fake.host);
    fake.children[0].report({ "watch:require": ["/app/server.js"] });
    fake.change("/app/server.js");
    await fake.tick(200);
    expect(fake.children[0].signals).toEqual(["SIGINT"]);
    expect(fake.state.output).not.toContain("\x1bc");
  });

  it("refuses an unknown kill signal as Node does", () => {
    const fake = fakeHost();
    let thrown: unknown;
    try {
      runWatchSupervisor(config({ killSignal: "9" }), fake.host);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "ERR_UNKNOWN_SIGNAL", message: "Unknown signal: 9" });
    expect(fake.children).toEqual([]);
  });

  it("with --watch-path watches those paths, recursively, and any change there restarts", async () => {
    const fake = fakeHost();
    fake.file("/app/src", "directory");
    runWatchSupervisor(config({ watchPaths: ["src"], execArgv: ["--watch-path=src"] }), fake.host);
    expect(fake.children[0].options.ipc).toBe(false);
    expect(fake.children[0].args).toEqual(["server.js"]);
    expect(fake.watches.map(({ target, recursive }) => ({ target, recursive }))).toEqual([
      { target: "/app/src", recursive: true },
    ]);
    fake.change("/app/src/deep/x.txt");
    await fake.tick(200);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toContain("Change detected in '/app/src/deep/x.txt'");
  });

  it("fails at once for a --watch-path that is not there", () => {
    const fake = fakeHost();
    expect(() => runWatchSupervisor(config({ watchPaths: ["nope"] }), fake.host)).toThrow(
      "ENOENT: no such file or directory, watch '/app/nope'",
    );
  });

  it("restarts when an --env-file changes", async () => {
    const fake = fakeHost();
    fake.file("/app/.env");
    runWatchSupervisor(
      config({
        envFiles: [
          { path: ".env", ifExists: false },
          { path: "x/.env", ifExists: true },
        ],
      }),
      fake.host,
    );
    fake.change("/app/.env");
    await fake.tick(200);
    expect(fake.children).toHaveLength(2);
  });

  it("ends the child with the signal it got and exits with the child's code", async () => {
    const fake = fakeHost();
    fake.file("/app/server.js");
    runWatchSupervisor(config(), fake.host);
    fake.children[0].report({ "watch:require": ["/app/server.js"] });
    await fake.signal("SIGINT");
    expect(fake.children[0].signals).toEqual(["SIGINT"]);
    // Ended by a signal, the child has no code: the supervisor exits 0, as Node's does.
    expect(fake.state.exitCode).toBe(0);
    expect(fake.openWatches()).toEqual([]);

    const crashed = fakeHost();
    runWatchSupervisor(config(), crashed.host);
    crashed.children[0].exit(3);
    await crashed.tick(0);
    await crashed.signal("SIGTERM");
    expect(crashed.children[0].signals).toEqual([]);
    expect(crashed.state.exitCode).toBe(3);
  });

  it("relays messages between its own parent and the child", () => {
    const toParent: unknown[] = [];
    const parentListeners: ((message: unknown) => void)[] = [];
    const fake = fakeHost({
      parent: {
        send: (message) => toParent.push(message),
        on: (listener) => parentListeners.push(listener),
        off: () => {},
      },
    });
    runWatchSupervisor(config(), fake.host);
    fake.children[0].report({ "watch:require": ["/app/server.js"] });
    fake.children[0].report("ready");
    parentListeners[0]("hello");
    expect(toParent).toEqual([{ "watch:require": ["/app/server.js"] }, "ready"]);
    expect(fake.children[0].sent).toEqual(["hello"]);
  });

  it("stops relaying for a child once it restarts it", async () => {
    const toParent: unknown[] = [];
    const parentListeners = new Set<(message: unknown) => void>();
    const fake = fakeHost({
      parent: {
        send: (message) => toParent.push(message),
        on: (listener) => parentListeners.add(listener),
        off: (listener) => parentListeners.delete(listener),
      },
    });
    fake.file("/app/server.js");
    runWatchSupervisor(config(), fake.host);
    const [first] = fake.children;
    first.report({ "watch:require": ["/app/server.js"] });
    fake.change("/app/server.js");
    await fake.tick(200);
    expect(fake.children).toHaveLength(2);
    // The parent's messages reach the new child only.
    expect(parentListeners.size).toBe(1);
    for (const listener of parentListeners) {
      listener("hello");
    }
    expect(first.sent).toEqual([]);
    expect(fake.children[1].sent).toEqual(["hello"]);
    // And nothing the old child still says goes up.
    toParent.length = 0;
    first.report("late");
    fake.children[1].report("ready");
    expect(toParent).toEqual(["ready"]);
  });
});

function tsxSettings(overrides: Partial<TsxWatchSettings> = {}): TsxWatchSettings {
  return {
    include: [],
    exclude: [],
    clearScreen: true,
    noCache: false,
    tsconfig: null,
    ...overrides,
  };
}

function tsxConfig(settings: Partial<TsxWatchSettings> = {}): WatchConfig {
  return config({
    execArgv: ["--env-file=.env"],
    command: ["src/server.ts", "--port", "3"],
    script: "src/server.ts",
    tsx: tsxSettings(settings),
  });
}

describe("tsx watch", () => {
  it("runs the program with tsx's environment, watching the script before it starts", () => {
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    runWatchSupervisor(tsxConfig({ noCache: true, tsconfig: "tsconfig.app.json" }), fake.host);
    const [child] = fake.children;
    expect(child.args).toEqual([
      TSX_CHILD_OPTION,
      "--env-file=.env",
      "src/server.ts",
      "--port",
      "3",
    ]);
    expect(child.options).toEqual({
      ipc: true,
      env: { PATH: "/bin", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: "tsconfig.app.json" },
    });
    expect(fake.openWatches()).toEqual(["/app/src"]);
  });

  it("restarts on a change, 100 ms after the last one, with tsx's message", async () => {
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    fake.file("/app/src/routes.ts");
    runWatchSupervisor(tsxConfig(), fake.host);
    const first = fake.children[0];
    first.report({ type: "dependency", path: "file:///app/src/routes.ts" });
    fake.change("/app/src/server.ts");
    await fake.tick(60);
    fake.change("/app/src/routes.ts");
    await fake.tick(60);
    expect(first.signals).toEqual([]);
    await fake.tick(40);
    expect(first.signals).toEqual(["SIGTERM"]);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toBe("10:00:00 AM [tsx] change in ./src/routes.ts Restarting...\n");
  });

  it("does not watch dependencies, dot files or what --exclude names", async () => {
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    fake.file("/app/node_modules/express/index.js");
    fake.file("/app/.config/x.ts");
    fake.file("/app/src/gen/out.ts");
    fake.file("/app/src/keep.ts");
    runWatchSupervisor(tsxConfig({ exclude: ["src/gen", "**/*.spec.ts"] }), fake.host);
    const child = fake.children[0];
    for (const path of [
      "/app/node_modules/express/index.js",
      "/app/.config/x.ts",
      "/app/src/gen/out.ts",
      "/app/src/a.spec.ts",
      "/app/src/keep.ts",
    ]) {
      child.report({ type: "dependency", path });
    }
    expect(fake.openWatches()).toEqual(["/app/src"]);
    fake.change("/app/node_modules/express/index.js");
    fake.change("/app/src/gen/out.ts");
    await fake.tick(500);
    expect(fake.children).toHaveLength(1);
    fake.change("/app/src/keep.ts");
    await fake.tick(100);
    expect(fake.children).toHaveLength(2);
  });

  it("watches what --include names, and !-patterns exclude", async () => {
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    fake.file("/app/views", "directory");
    runWatchSupervisor(tsxConfig({ include: ["views/**/*.html", "!views/draft/**"] }), fake.host);
    expect(fake.watches.map(({ target, recursive }) => ({ target, recursive }))).toEqual([
      { target: "/app/src", recursive: false },
      { target: "/app/views", recursive: true },
    ]);
    fake.file("/app/views/a/page.css");
    fake.change("/app/views/a/page.css", "rename");
    fake.file("/app/views/draft/x.html");
    fake.change("/app/views/draft/x.html", "rename");
    await fake.tick(500);
    expect(fake.children).toHaveLength(1);
    fake.file("/app/views/a/page.html");
    fake.change("/app/views/a/page.html", "rename");
    await fake.tick(100);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toBe("10:00:00 AM [tsx] add in ./views/a/page.html Restarting...\n");
  });

  it("names an event as chokidar does: a new file was added, a quick re-creation changed", async () => {
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    fake.file("/app/cfg", "directory");
    runWatchSupervisor(tsxConfig({ include: ["cfg/**/*.txt"], clearScreen: false }), fake.host);
    fake.children[0].exit(0);
    // Creating a file: fs.watch says "rename", then "change" for its first write.
    fake.file("/app/cfg/new.txt");
    fake.change("/app/cfg/new.txt", "rename");
    fake.change("/app/cfg/new.txt", "change");
    await fake.tick(100);
    fake.children[1].exit(0);
    // Deleted, then created again within chokidar's 100 ms `atomic` window.
    fake.remove("/app/cfg/new.txt");
    fake.change("/app/cfg/new.txt", "rename");
    await fake.tick(50);
    fake.file("/app/cfg/new.txt");
    fake.change("/app/cfg/new.txt", "rename");
    fake.change("/app/cfg/new.txt", "change");
    await fake.tick(100);
    fake.children[2].exit(0);
    // Deleted, then created again later.
    fake.remove("/app/cfg/new.txt");
    fake.change("/app/cfg/new.txt", "rename");
    await fake.tick(1000);
    fake.children[3].exit(0);
    fake.file("/app/cfg/new.txt");
    fake.change("/app/cfg/new.txt", "rename");
    fake.change("/app/cfg/new.txt", "change");
    await fake.tick(100);
    expect(fake.state.output).toBe(
      "10:00:00 AM [tsx] add in ./cfg/new.txt Rerunning...\n" +
        "10:00:00 AM [tsx] change in ./cfg/new.txt Rerunning...\n" +
        "10:00:00 AM [tsx] unlink in ./cfg/new.txt Rerunning...\n" +
        "10:00:00 AM [tsx] add in ./cfg/new.txt Rerunning...\n",
    );
  });

  it("names a folder as chokidar does, the --include folder itself too", async () => {
    // tsx 4.23.13, `--include views`: `rm -r views`, `mkdir views`, a file in
    // it, then a folder made in it and removed again.
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    fake.file("/app/views/a.html");
    runWatchSupervisor(tsxConfig({ include: ["views"], clearScreen: false }), fake.host);
    const steps: (() => void)[] = [
      () => {
        // The folder's entries go first; its own event carries its own name.
        fake.remove("/app/views/a.html");
        fake.change("/app/views/a.html", "rename");
        fake.remove("/app/views");
        fake.change("/app/views", "rename");
      },
      () => {
        fake.file("/app/views", "directory");
        fake.change("/app/views", "rename");
      },
      () => {
        fake.file("/app/views/a.html");
        fake.change("/app/views/a.html", "rename");
      },
      () => {
        fake.file("/app/views/partials", "directory");
        fake.change("/app/views/partials", "rename");
      },
      () => {
        fake.remove("/app/views/partials");
        fake.change("/app/views/partials", "rename");
      },
    ];
    for (const [index, step] of steps.entries()) {
      fake.children[index].exit(0);
      step();
      await fake.tick(100);
    }
    expect(fake.state.output).toBe(
      "10:00:00 AM [tsx] unlinkDir in ./views Rerunning...\n" +
        "10:00:00 AM [tsx] addDir in ./views Rerunning...\n" +
        "10:00:00 AM [tsx] add in ./views/a.html Rerunning...\n" +
        "10:00:00 AM [tsx] addDir in ./views/partials Rerunning...\n" +
        "10:00:00 AM [tsx] unlinkDir in ./views/partials Rerunning...\n",
    );
  });

  it("names what went as what it was before tsx started: a folder by unlinkDir", async () => {
    // tsx 4.23.1, `--include views` over views/empty, views/full/deep,
    // views/full/a.html and views/f.html: `rmdir views/empty`, `rmdir
    // views/full/deep`, `rm views/f.html` (test/cases/watch-tsx-folders.cjs).
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    fake.file("/app/views/empty", "directory");
    fake.file("/app/views/full/deep", "directory");
    fake.file("/app/views/full/a.html");
    fake.file("/app/views/f.html");
    runWatchSupervisor(tsxConfig({ include: ["views"], clearScreen: false }), fake.host);
    for (const [index, gone] of [
      "/app/views/empty",
      "/app/views/full/deep",
      "/app/views/f.html",
    ].entries()) {
      fake.children[index].exit(0);
      fake.remove(gone);
      fake.change(gone, "rename");
      await fake.tick(100);
    }
    expect(fake.state.output).toBe(
      "10:00:00 AM [tsx] unlinkDir in ./views/empty Rerunning...\n" +
        "10:00:00 AM [tsx] unlinkDir in ./views/full/deep Rerunning...\n" +
        "10:00:00 AM [tsx] unlink in ./views/f.html Rerunning...\n",
    );
  });

  it("reruns a program that already ended, and clears a terminal first", async () => {
    const fake = fakeHost({ stdoutIsTTY: true, tsxColors: true });
    fake.file("/app/src/server.ts");
    runWatchSupervisor(tsxConfig(), fake.host);
    fake.children[0].exit(1);
    fake.remove("/app/src/server.ts");
    fake.change("/app/src/server.ts", "rename");
    await fake.tick(100);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toBe(
      "\x1b[90m10:00:00 AM\x1b[39m \x1b[96m[tsx]\x1b[39m \x1b[95munlink\x1b[39m in " +
        "\x1b[92m./src/server.ts\x1b[39m \x1b[33mRerunning...\x1b[39m\n\x1bc",
    );
  });

  it("does not clear the screen with --clear-screen=false", async () => {
    const fake = fakeHost({ stdoutIsTTY: true });
    fake.file("/app/src/server.ts");
    runWatchSupervisor(tsxConfig({ clearScreen: false }), fake.host);
    fake.change("/app/src/server.ts");
    await fake.tick(100);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).not.toContain("\x1bc");
  });

  it("reruns on Enter", async () => {
    const fake = fakeHost();
    runWatchSupervisor(tsxConfig(), fake.host);
    fake.state.input?.();
    await fake.tick(100);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toBe("10:00:00 AM [tsx] Return key Restarting...\n");
  });

  it("forces a program that does not stop, after 5 s or on the next change", async () => {
    const fake = fakeHost();
    fake.file("/app/src/server.ts");
    runWatchSupervisor(tsxConfig(), fake.host);
    const stubborn = fake.children[0];
    stubborn.endsOnKill = false;
    fake.change("/app/src/server.ts");
    await fake.tick(100);
    fake.change("/app/src/server.ts");
    await fake.tick(100);
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await fake.tick(5000);
    expect(stubborn.signals).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
    stubborn.exit(null, "SIGKILL");
    await fake.tick(0);
    expect(fake.children).toHaveLength(2);
    expect(fake.state.output).toBe(
      "10:00:00 AM [tsx] change in ./src/server.ts Restarting...\n" +
        "10:00:00 AM [tsx] change in ./src/server.ts Process hasn't exited. Killing process...\n" +
        "10:00:00 AM [tsx] Process didn't exit in 5s. Force killing...\n",
    );
  });

  it("on Ctrl+C ends the program and exits 130, as tsx's program would", async () => {
    const running = fakeHost();
    runWatchSupervisor(tsxConfig(), running.host);
    await running.signal("SIGINT");
    expect(running.children[0].signals).toEqual(["SIGINT"]);
    expect(running.state.exitCode).toBe(130);

    const ended = fakeHost();
    runWatchSupervisor(tsxConfig(), ended.host);
    ended.children[0].exit(0);
    await ended.signal("SIGTERM");
    expect(ended.state.exitCode).toBe(143);
    // Nothing is started after a signal.
    ended.state.input?.();
    await ended.tick(100);
    expect(ended.children).toHaveLength(1);
  });

  it("gives the program an IPC channel of its own when the supervisor has one", () => {
    const fake = fakeHost({ parent: { send: () => {}, on: () => {}, off: () => {} } });
    runWatchSupervisor(tsxConfig(), fake.host);
    expect(fake.children[0].args[0]).toBe(`${TSX_CHILD_OPTION}=ipc`);
  });

  it("with no script says so, prints tsx's usage and exits 1, starting nothing", () => {
    // tsx 4.23.13, `tsx watch` and `tsx watch --exclude a.ts`: the error on
    // standard error, the usage on standard output, exit 1.
    const usage = (usageHeading: string, flagsHeading: string) =>
      [
        "tsx watch",
        "",
        "Run the script and watch for changes",
        "",
        usageHeading,
        "  tsx watch [flags...] <script path>",
        "",
        flagsHeading,
        "      --clear-screen             Clearing the screen on rerun (default: true)",
        "      --exclude <string>         Paths & globs to exclude from being watched",
        "  -h, --help                     Show help",
        "      --ignore <string>          Paths & globs to exclude from being watched (Deprecated: use --exclude)",
        "      --include <string>         Additional paths & globs to watch",
        "      --no-cache                 Disable caching",
        "      --tsconfig <string>        Custom tsconfig.json path",
        "",
        "",
      ].join("\n");
    const noScript = config({
      execArgv: ["--no-warnings"],
      command: [],
      script: null,
      tsx: tsxSettings({ include: ["views"] }),
    });
    const fake = fakeHost();
    fake.file("/app/views", "directory");
    runWatchSupervisor(noScript, fake.host);
    expect(fake.state.errors).toBe('Error: Missing required parameter "script path"\n\n');
    expect(fake.state.output).toBe(usage("USAGE:", "FLAGS:"));
    expect(fake.state.exitCode).toBe(1);
    expect(fake.children).toEqual([]);
    expect(fake.watches).toEqual([]);
    expect(fake.state.input).toBeNull();

    // The headings are bold where the environment has colors, as cleye prints them.
    const colored = fakeHost({ environmentColors: true });
    runWatchSupervisor(noScript, colored.host);
    expect(colored.state.output).toBe(usage("\x1b[1mUsage:\x1b[22m", "\x1b[1mFlags:\x1b[22m"));
    expect(colored.state.exitCode).toBe(1);
  });

  it("takes `-` for the script: the program reads it from standard input", () => {
    const fake = fakeHost();
    runWatchSupervisor(
      config({ execArgv: [], command: ["-"], script: null, tsx: tsxSettings() }),
      fake.host,
    );
    expect(fake.state.errors).toBe("");
    expect(fake.children.map((child) => child.args)).toEqual([[TSX_CHILD_OPTION, "-"]]);
  });
});

describe("the child's reports", () => {
  const fakeProcess = (connected: boolean) => {
    const sent: unknown[] = [];
    const process = {
      connected,
      send: (message: unknown) => {
        sent.push(message);
        return true;
      },
    } as unknown as NodeProcess;
    return { process, sent };
  };

  it("sends Node's messages, once a file, when WATCH_REPORT_DEPENDENCIES is set", () => {
    const { port1, port2 } = new MessageChannel();
    try {
      const { process, sent } = fakeProcess(true);
      const report = watchReporter({
        env: { WATCH_REPORT_DEPENDENCIES: "1" },
        process,
        ipc: port1,
        tsxChild: false,
        parentPort: null,
      })!;
      report("require", "/app/a b.js");
      report("import", "/app/m.mjs");
      report("require", "/app/a b.js");
      report("missing", "/app/later.js");
      expect(sent).toEqual([
        { "watch:require": ["/app/a b.js"] },
        { "watch:import": ["file:///app/m.mjs"] },
        { "watch:require": ["/app/later.js"] },
      ]);
      expect(
        watchReporter({ env: {}, process, ipc: port1, tsxChild: false, parentPort: null }),
      ).toBeNull();
      expect(
        watchReporter({
          env: { WATCH_REPORT_DEPENDENCIES: "1" },
          process,
          ipc: null,
          tsxChild: false,
          parentPort: null,
        }),
      ).toBeNull();
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("under tsx posts tsx's report on the channel the program does not see", async () => {
    const { port1, port2 } = new MessageChannel();
    try {
      const received: unknown[] = [];
      port2.onmessage = (event) => received.push(event.data);
      const { process, sent } = fakeProcess(false);
      const report = watchReporter({
        env: {},
        process,
        ipc: port1,
        tsxChild: true,
        parentPort: null,
      })!;
      report("import", "/app/src/server.ts");
      report("require", "/app/src/server.ts");
      // tsx's loader reports neither of these.
      report("missing", "/app/src/later.ts");
      report("require", "/app/data.json");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent).toEqual([]);
      expect(received).toEqual([
        { type: "message", message: { type: "dependency", path: "/app/src/server.ts" } },
      ]);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("in a worker thread posts Node's messages on its parentPort, for its parent to pass on", async () => {
    const { port1, port2 } = new MessageChannel();
    try {
      const received: unknown[] = [];
      port2.onmessage = (event) => received.push(event.data);
      const { process, sent } = fakeProcess(false);
      const report = watchReporter({
        env: { WATCH_REPORT_DEPENDENCIES: "1" },
        process,
        ipc: null,
        tsxChild: false,
        parentPort: port1,
      })!;
      report("require", "/app/w.js");
      report("import", "/app/dep.mjs");
      report("require", "/app/w.js");
      // A thread does not report what a failed require() looked for (Node's
      // reportModuleNotFoundToWatchMode sends only from the main thread).
      report("missing", "/app/later.js");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent).toEqual([]);
      expect(received).toEqual([
        { "watch:require": ["/app/w.js"] },
        { "watch:import": ["file:///app/dep.mjs"] },
      ]);
      // A thread started with an environment of its own, without the variable, reports nothing.
      expect(
        watchReporter({ env: {}, process, ipc: null, tsxChild: false, parentPort: port1 }),
      ).toBeNull();
    } finally {
      port1.close();
      port2.close();
    }
  });
});

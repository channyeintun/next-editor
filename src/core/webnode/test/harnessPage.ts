// The page side of the browser harness (scripts/webnode-harness.ts): boots a
// runtime and exposes a small driver on `window` that the harness calls through
// the browser's automation protocol.
import { WebNode } from "../api";
import type { FileSystemTree, WebNodeProcess } from "../api";
import { findInOutput } from "./outputMatch";
import type { OutputMatch } from "./outputMatch";

interface Running {
  process: WebNodeProcess;
  output: string;
  exited: number | null;
  /** Everything the process printed has arrived: its output stream has ended. */
  drained: boolean;
}

/** The size a started command's terminal has unless the caller names one. */
const DEFAULT_TERMINAL = { cols: 100, rows: 30 };

interface Harness {
  boot(): Promise<{ workdir: string }>;
  mount(tree: FileSystemTree): Promise<void>;
  /** Runs a command to its exit (or kills it at the timeout) and returns what it printed. */
  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; env?: Record<string, string>; input?: string },
  ): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /**
   * Starts a command on a terminal and returns a handle id for `read`, `write`,
   * `waitFor`, `match`, `resize` and `kill`.
   */
  start(
    command: string,
    args: string[],
    env?: Record<string, string>,
    terminal?: { cols: number; rows: number },
  ): Promise<number>;
  read(id: number): { output: string; exited: number | null };
  /** Types `text`. Answers how much the process had printed until then. */
  write(id: number, text: string): Promise<number>;
  /**
   * Whether `pattern` shows anywhere in all the process printed, before the
   * timeout. False at the timeout: it never throws.
   */
  waitFor(id: number, pattern: string, timeoutMs: number): Promise<boolean>;
  /**
   * Waits for `pattern` in what the process printed from offset `from` on.
   * Null at the timeout, and once the process has ended without printing it.
   */
  match(id: number, pattern: string, from: number, timeoutMs: number): Promise<OutputMatch | null>;
  /** Gives the process's terminal a new size, as a resized window does. */
  resize(id: number, cols: number, rows: number): void;
  kill(id: number): void;
  servers(): { port: number; url: string }[];
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  teardown(): void;
}

let instance: WebNode | null = null;
const running = new Map<number, Running>();
const servers: { port: number; url: string }[] = [];
let nextId = 1;

function runtime(): WebNode {
  if (!instance) {
    throw new Error("harness: boot() first");
  }
  return instance;
}

function track(process: WebNodeProcess): number {
  const id = nextId++;
  const record: Running = { process, output: "", exited: null, drained: false };
  running.set(id, record);
  const drained = () => {
    record.drained = true;
  };
  void process.output
    .pipeTo(
      new WritableStream({
        write(chunk) {
          record.output += chunk;
        },
      }),
    )
    .then(drained, drained);
  void process.exit.then((code) => {
    record.exited = code;
  });
  return id;
}

const harness: Harness = {
  async boot() {
    // A deployment's hosts live under a domain of their own, named in the address.
    const query = new URLSearchParams(location.search);
    const previewHost = query.get("previewHost");
    instance = await WebNode.boot({
      // `?fs=kernel`: the filesystem inside the kernel worker, to compare with.
      sharedFilesystem: query.get("fs") !== "kernel",
      previewBase: previewHost
        ? { protocol: "https:", host: previewHost }
        : { protocol: location.protocol as "http:" | "https:", host: location.host },
      workdirName: "app",
      forwardPreviewErrors: true,
    });
    instance.on("port", (port, type, url) => {
      const index = servers.findIndex((server) => server.port === port);
      if (type === "open" && index < 0) {
        servers.push({ port, url });
      } else if (type === "close" && index >= 0) {
        servers.splice(index, 1);
      }
    });
    return { workdir: instance.workdir };
  },
  mount: (tree) => runtime().mount(tree),
  async run(command, args, options = {}) {
    const process = await runtime().spawn(command, args, { env: options.env });
    const id = track(process);
    const record = running.get(id)!;
    if (options.input !== undefined) {
      const writer = process.input.getWriter();
      await writer.write(options.input);
      writer.releaseLock();
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, options.timeoutMs ?? 30000);
    const code = await process.exit;
    clearTimeout(timer);
    // The exit is heard before the last of the output: wait for that too.
    const patience = Date.now() + 2000;
    while (!record.drained && Date.now() < patience) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    running.delete(id);
    return { code: timedOut ? null : code, output: record.output.replace(/\r/g, ""), timedOut };
  },
  async start(command, args, env, terminal = DEFAULT_TERMINAL) {
    return track(await runtime().spawn(command, args, { env, terminal }));
  },
  read(id) {
    const record = running.get(id);
    return { output: record?.output ?? "", exited: record?.exited ?? null };
  },
  async write(id, text) {
    const record = running.get(id);
    if (!record) {
      throw new Error(`harness: no process ${id} to type into`);
    }
    const printed = record.output.length;
    const writer = record.process.input.getWriter();
    await writer.write(text);
    writer.releaseLock();
    return printed;
  },
  async waitFor(id, pattern, timeoutMs) {
    const expression = new RegExp(pattern);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = running.get(id);
      if (!record) {
        return false;
      }
      if (expression.test(record.output)) {
        return true;
      }
      // The exit is heard before the last of the output: wait for that too.
      if (record.exited !== null && record.drained) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  },
  async match(id, pattern, from, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = running.get(id);
      if (!record) {
        return null;
      }
      const found = findInOutput(record.output, pattern, from);
      if (found) {
        return found;
      }
      // The exit is heard before the last of the output: wait for that too.
      if ((record.exited !== null && record.drained) || Date.now() >= deadline) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  },
  resize(id, cols, rows) {
    const record = running.get(id);
    if (!record) {
      throw new Error(`harness: no process ${id} to resize`);
    }
    record.process.resize({ cols, rows });
  },
  kill(id) {
    running.get(id)?.process.kill();
  },
  servers: () => [...servers],
  readFile: (path) => runtime().fs.readFile(path, "utf-8"),
  readdir: (path) => runtime().fs.readdir(path),
  teardown() {
    instance?.teardown();
    instance = null;
    running.clear();
    servers.length = 0;
  },
};

(window as unknown as { webnodeHarness: Harness }).webnodeHarness = harness;

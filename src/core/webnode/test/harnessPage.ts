// The page side of the browser harness (scripts/webnode-harness.ts): boots a
// runtime and exposes a small driver on `window` that the harness calls through
// the browser's automation protocol.
import { WebNode } from "../api";
import type { FileSystemTree, WebNodeProcess } from "../api";

interface Running {
  process: WebNodeProcess;
  output: string;
  exited: number | null;
}

interface Harness {
  boot(): Promise<{ workdir: string }>;
  mount(tree: FileSystemTree): Promise<void>;
  /** Runs a command to its exit (or kills it at the timeout) and returns what it printed. */
  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; env?: Record<string, string>; input?: string },
  ): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** Starts a command and returns a handle id for `read`, `write`, `waitFor`, `kill`. */
  start(command: string, args: string[], env?: Record<string, string>): Promise<number>;
  read(id: number): { output: string; exited: number | null };
  write(id: number, text: string): Promise<void>;
  waitFor(id: number, pattern: string, timeoutMs: number): Promise<boolean>;
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
  const record: Running = { process, output: "", exited: null };
  running.set(id, record);
  void process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        record.output += chunk;
      },
    }),
  );
  void process.exit.then((code) => {
    record.exited = code;
  });
  return id;
}

const harness: Harness = {
  async boot() {
    instance = await WebNode.boot({
      previewBase: { protocol: location.protocol as "http:" | "https:", host: location.host },
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
    // Let the last output chunk through.
    await new Promise((resolve) => setTimeout(resolve, 20));
    running.delete(id);
    return { code: timedOut ? null : code, output: record.output.replace(/\r/g, ""), timedOut };
  },
  async start(command, args, env) {
    return track(await runtime().spawn(command, args, { env, terminal: { cols: 100, rows: 30 } }));
  },
  read(id) {
    const record = running.get(id);
    return { output: record?.output ?? "", exited: record?.exited ?? null };
  },
  async write(id, text) {
    const writer = running.get(id)!.process.input.getWriter();
    await writer.write(text);
    writer.releaseLock();
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
      if (record.exited !== null) {
        return expression.test(record.output);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
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

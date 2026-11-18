// Test support for the shell: runs `runShell` against the fake process
// runtime with a small filesystem and a scripted set of external commands,
// or against the real kernel (its pipes and terminal) with the shell's
// process played by a real sysClient in this thread.
import { Kernel } from "../../../kernel/kernel";
import type { KernelHost, KernelWorker } from "../../../kernel/kernel";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { Vfs } from "../../../kernel/vfs/vfs";
import type { KernelEvent, KernelMessage, ProcessInit, ProcessMessage } from "../../../protocol";
import type { ProcessRuntime, SpawnRequest } from "../../runtime";
import { setRuntime } from "../../runtime";
import { createProcessClient } from "../../sysClient";
import type { ProcessClient } from "../../sysClient";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import type { FakeChildIo, FakeRuntime } from "../../testing/fakeRuntime";
import { runShell } from "./index";

const encoder = new TextEncoder();

/** Resolves after `ms`. */
export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** What `waiting` resolves to, or "still running" after `ms`: a shell that never ends fails its test, not the run. */
export function within<T>(waiting: Promise<T>, ms = 1500): Promise<T | "still running"> {
  return Promise.race([waiting, pause(ms).then(() => "still running" as const)]);
}

/** Waits (up to 3 s) until `ready` holds; whether it did. */
export async function until(ready: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (!ready() && Date.now() < deadline) {
    await pause(2);
  }
  return ready();
}

/** Reads a fake child's whole standard input. */
export async function childStdin(io: FakeChildIo): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < 10000; i++) {
    const chunk = io.readStdin();
    if (chunk === null) {
      break;
    }
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new TextDecoder().decode(
    chunks.reduce((all, chunk) => {
      const next = new Uint8Array(all.length + chunk.length);
      next.set(all);
      next.set(chunk, all.length);
      return next;
    }, new Uint8Array(0)),
  );
}

/**
 * The external commands tests can run: `node` (prints its arguments),
 * `upper` (upper-cases stdin), `fail N` (exits N), `err` (writes to stderr),
 * `printenv NAME`, `pwdx` (prints its cwd), `hang` (waits for a signal).
 */
export async function defaultExternal(request: SpawnRequest, io: FakeChildIo): Promise<number> {
  const [first] = request.args;
  switch (request.command) {
    case "node":
      io.writeStdout(`node ${request.args.join(" ")}\n`);
      return 0;
    case "upper":
      io.writeStdout((await childStdin(io)).toUpperCase());
      return 0;
    case "fail":
      return Number(first ?? "1");
    case "err":
      io.writeStderr(`${request.args.join(" ")}\n`);
      return 0;
    case "printenv":
      io.writeStdout(`${request.env[first] ?? ""}\n`);
      return 0;
    case "pwdx":
      io.writeStdout(`${request.cwd}\n`);
      return 0;
    case "argv":
      io.writeStdout(`${request.args.map((arg) => `<${arg}>`).join("")}\n`);
      return 0;
    case "hang":
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return 0;
  }
  throw new Error(`no such fake command ${request.command}`);
}

export interface RunOptions {
  files?: Record<string, string>;
  stdin?: string;
  /** Leave stdin open (for tests that feed it later). */
  keepStdinOpen?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  tty?: boolean;
  spawn?: (request: SpawnRequest, io: FakeChildIo) => number | Promise<number>;
  /** External commands that exist (anything else is ENOENT). */
  externals?: string[];
}

export interface RunResult {
  status: number;
  out: string;
  err: string;
  rt: FakeRuntime;
  vfs: Vfs;
}

/** Builds the fake runtime the shell tests use and installs it. */
export function setupRuntime(options: RunOptions = {}): { rt: FakeRuntime; vfs: Vfs } {
  const vfs = new Vfs();
  for (const dir of ["/home", "/tmp", "/dev", "/bin", "/work"]) {
    vfs.mkdir(dir, true, 0o755);
  }
  // The fake has no devices: an empty file reads as /dev/null does.
  vfs.writeFile("/dev/null", new Uint8Array(0), O_WRONLY | O_CREAT | O_TRUNC, 0o666);
  const externals = new Set(
    options.externals ?? ["node", "upper", "fail", "err", "printenv", "pwdx", "argv", "hang"],
  );
  for (const name of externals) {
    vfs.writeFile(
      `/bin/${name}`,
      encoder.encode("#!/bin/node\n"),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o755,
    );
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    vfs.mkdir(dir, true, 0o755);
    vfs.writeFile(path, encoder.encode(content), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  }
  const spawn = options.spawn ?? defaultExternal;
  const rt = createFakeRuntime({
    vfs,
    cwd: options.cwd ?? "/work",
    env: { HOME: "/home", PATH: "/bin", USER: "user", ...options.env },
    tty: options.tty,
    spawn,
  });
  // The fake throws ENOENT only without a callback; emulate PATH lookup here.
  const originalSpawn = rt.processes.spawn;
  rt.processes.spawn = (request) => {
    const name = request.command.slice(request.command.lastIndexOf("/") + 1);
    if (!externals.has(name)) {
      const error = Object.assign(
        new Error(`ENOENT: no such file or directory, spawn '${request.command}'`),
        {
          code: "ENOENT",
          errno: -2,
          syscall: `spawn ${request.command}`,
          path: request.command,
        },
      );
      throw error;
    }
    return originalSpawn(request);
  };
  const listeners: SignalListener[] = [];
  signalListeners.set(rt, listeners);
  const onSignal = rt.processes.onSignal;
  rt.processes.onSignal = (listener) => {
    listeners.push(listener);
    onSignal(listener);
  };
  setRuntime(rt);
  return { rt, vfs };
}

/** What a process registers to hear of its signals, and whether one is the terminal's. */
type SignalListener = (signal: string, fromTerminal: boolean) => boolean;

/** The signal listeners of the shell run on each fake runtime `setupRuntime` built. */
const signalListeners = new WeakMap<FakeRuntime, SignalListener[]>();

/**
 * Delivers `signal` to the shell run on `rt` (a runtime `setupRuntime`
 * built), saying where it came from: the terminal, which sent it to the
 * shell's foreground programs as well, or a kill of the shell alone.
 */
export function deliverSignal(rt: FakeRuntime, signal: string, fromTerminal: boolean): void {
  for (const listener of signalListeners.get(rt) ?? []) {
    listener(signal, fromTerminal);
  }
}

/** The terminal's Ctrl+C for the shell run on `rt`. */
export function terminalInterrupt(rt: FakeRuntime): void {
  deliverSignal(rt, "SIGINT", true);
}

/** Runs `sh -c script` (or the given argv) and collects the outcome. */
export async function sh(script: string | string[], options: RunOptions = {}): Promise<RunResult> {
  const { rt, vfs } = setupRuntime(options);
  if (options.stdin !== undefined) {
    rt.feedStdin(options.stdin);
  }
  if (!options.keepStdinOpen) {
    rt.feedStdin(null);
  }
  const argv = typeof script === "string" ? ["sh", "-c", script] : script;
  const status = await runShell(argv);
  return { status, out: rt.stdout(), err: rt.stderr(), rt, vfs };
}

/** Reads a file of the fake filesystem as text. */
export function readText(vfs: Vfs, path: string): string {
  return new TextDecoder().decode(vfs.readFile(path));
}

/**
 * Thrown in a process the kernel ended in place of answering its blocking
 * call (a signal it left to its default action, a `kill` of itself): a real
 * worker stops there, and this thread would wait for the answer for ever.
 */
class ProcessEnded extends Error {
  constructor() {
    super("the kernel ended this process");
  }
}

/** A process worker played by a real sysClient in this thread (children run only as `programs` say). */
class ClientWorker implements KernelWorker {
  onmessage: ((event: MessageEvent<ProcessMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  init: ProcessInit | null = null;
  client: ProcessClient | null = null;
  terminated = false;

  /** Runs once the kernel has sent this worker its `init`. */
  onInit: ((init: ProcessInit) => void) | null = null;

  postMessage(message: KernelMessage): void {
    if (message.type === "init") {
      this.init = message;
      this.onInit?.(message);
      return;
    }
    // Messages reach a worker in a later task.
    setImmediate(() => {
      if (this.terminated) {
        return;
      }
      try {
        this.client?.receive(message);
      } catch (error) {
        // The message ended the process (a signal with its default action).
        if (!(error instanceof ProcessEnded)) {
          throw error;
        }
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** What this worker sends the kernel. */
  send(message: ProcessMessage, transfer: Transferable[] = []): void {
    this.onmessage?.({
      data: message,
      ports: transfer.filter((item) => item instanceof MessagePort),
    } as unknown as MessageEvent<ProcessMessage>);
    if (message.type === "sync" && this.terminated) {
      throw new ProcessEnded();
    }
  }
}

/**
 * A process a kernel shell started (`node <script>` and the like), as the
 * test sees it. It runs nothing unless `programs` gives its script a program.
 */
export interface KernelChild {
  pid: number;
  argv: string[];
  /** Whether the kernel has ended it. */
  readonly terminated: boolean;
  /** Sends the kernel a message as this process (a post or call; a blocking call never returns here). */
  send(message: ProcessMessage): void;
  /** Ends it with `code`, as `process.exit` does. */
  exit(code: number): void;
}

/**
 * A program a test plays as such a process, with a runtime of its own (the
 * global one is the shell's). Its calls must not block: use `fs.readAsync`,
 * and `fdStream.write` with a completion.
 */
export type ChildProgram = (child: KernelChild, runtime: ProcessRuntime) => void | Promise<void>;

/** A shell the page started on the real kernel: `sh -c …` or an interactive `jsh`. */
export interface KernelShell {
  kernel: Kernel;
  vfs: Vfs;
  pid: number;
  /** The processes the shell started, oldest first. */
  children(): KernelChild[];
  /** Resolves with the shell's exit status. */
  done: Promise<number>;
  /** What the shell's terminal showed so far, with CR LF made LF. */
  output(): string;
  /** Types into the shell's terminal. */
  type(text: string): void;
  /** Waits (up to `ms`) until the terminal shows `text`; false when it never did. */
  waitFor(text: string | RegExp, ms?: number): Promise<boolean>;
}

/**
 * Makes `worker`, which the kernel started for `init`, a process the test
 * sees (added to `children`), running the program `programs` gives its
 * script or command, if any.
 */
function adoptChild(
  worker: ClientWorker,
  init: ProcessInit,
  children: KernelChild[],
  programs: Record<string, ChildProgram>,
): void {
  if (init.thread) {
    return;
  }
  const child: KernelChild = {
    pid: init.pid,
    argv: init.argv,
    get terminated() {
      return worker.terminated;
    },
    send: (message) => worker.send(message),
    exit: (code) => worker.send({ type: "post", op: "proc.exit", args: [code] }),
  };
  children.push(child);
  const name = init.argv[0] === "node" ? (init.argv[1] ?? "") : init.argv[0];
  const program = programs[name.slice(name.lastIndexOf("/") + 1)];
  if (!program) {
    return;
  }
  const client = createProcessClient(
    { postMessage: (message, transfer) => worker.send(message, transfer ?? []) },
    init,
  );
  worker.client = client;
  // Once the spawn that started it has returned; a failure fails the test.
  setImmediate(() => void program(child, client.runtime));
}

/** Writes `files` (path: text) into `vfs`. */
function writeFiles(vfs: Vfs, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    vfs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", true, 0o755);
    vfs.writeFile(path, encoder.encode(content), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  }
}

/** What the terminal of page process `pid` showed, with CR LF made LF. */
function terminalOutput(events: KernelEvent[], pid: number): string {
  return events
    .filter((event) => event.event === "output" && event.pid === pid)
    .map((event) => (event as { data: string }).data)
    .join("")
    .replace(/\r\n/g, "\n");
}

/** Waits (up to `ms`) until `shown()` holds `text`; false when it never did. */
async function shows(shown: () => string, text: string | RegExp, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const output = shown();
    if (typeof text === "string" ? output.includes(text) : text.test(output)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return false;
}

/**
 * Starts `argv` (`["sh", "-c", line]`, `["jsh"]`) as a page process of a real
 * kernel, its stdio the kernel's terminal. A child whose script (`node
 * count.js`: `count.js`) or command `programs` names runs that program.
 */
export function kernelShell(
  argv: string[],
  files: Record<string, string> = {},
  programs: Record<string, ChildProgram> = {},
): KernelShell {
  const workers: ClientWorker[] = [];
  const events: KernelEvent[] = [];
  const children: KernelChild[] = [];
  const adopt = (worker: ClientWorker, init: ProcessInit) =>
    adoptChild(worker, init, children, programs);
  const host: KernelHost = {
    createWorker() {
      const worker = new ClientWorker();
      // The first is the shell's own.
      if (workers.length > 0) {
        worker.onInit = (init) => adopt(worker, init);
      }
      workers.push(worker);
      return worker;
    },
    emit(event) {
      events.push(event);
    },
  };
  const vfs = new Vfs();
  const kernel = new Kernel(vfs, host, "app");
  writeFiles(vfs, files);
  const pid = kernel.spawnFromPage(argv[0], argv.slice(1), {});
  const worker = workers.at(-1)!;
  const client = createProcessClient(
    { postMessage: (message, transfer) => worker.send(message, transfer ?? []) },
    worker.init!,
  );
  worker.client = client;
  setRuntime(client.runtime);
  const output = () => terminalOutput(events, pid);
  return {
    kernel,
    vfs,
    pid,
    children: () => [...children],
    done: runShell(argv),
    output,
    type: (text) => kernel.writeInput(pid, text),
    waitFor: (text, ms = 3000) => shows(output, text, ms),
  };
}

/** A shell that a process on the real kernel started, as that parent has it. */
export interface SpawnedShell {
  kernel: Kernel;
  /** The shell's pid. */
  pid: number;
  /**
   * The runtime of the parent, a page process on a terminal that handles
   * SIGINT, SIGTERM and SIGHUP: with it the test reads or closes the pipes
   * to the shell and sends it signals, as a node parent would.
   */
  parent: ProcessRuntime;
  /** The parent's fd for each `"pipe"` entry of the shell's stdio, null for the others. */
  stdio: (number | null)[];
  /** How the shell ended, as its parent sees it: an exit code, or the signal it died of. */
  exit: Promise<{ code: number | null; signal: string | null }>;
  /** The processes the shell started, oldest first. */
  children(): KernelChild[];
  /** What the terminal showed so far, with CR LF made LF. */
  output(): string;
  /** Types into the terminal (a Ctrl+C reaches the parent, the shell and its foreground programs). */
  type(text: string): void;
  /** Waits (up to `ms`) until the terminal shows `text`; false when it never did. */
  waitFor(text: string | RegExp, ms?: number): Promise<boolean>;
}

/**
 * Starts `argv` (`["sh", "-c", line]`) on a real kernel as the child of a
 * page process, with the `stdio` that parent gives it (all inherited, the
 * terminal, unless said): what `child_process.spawn` of a shell is. The
 * shell's own children run the programs `programs` names, as `kernelShell`'s do.
 */
export function spawnedShell(
  argv: string[],
  options: {
    stdio?: SpawnRequest["stdio"];
    files?: Record<string, string>;
    programs?: Record<string, ChildProgram>;
  } = {},
): SpawnedShell {
  const workers: ClientWorker[] = [];
  const events: KernelEvent[] = [];
  const children: KernelChild[] = [];
  const client = (worker: ClientWorker, init: ProcessInit): ProcessClient => {
    const made = createProcessClient(
      { postMessage: (message, transfer) => worker.send(message, transfer ?? []) },
      init,
    );
    worker.client = made;
    return made;
  };
  const startShell = (worker: ClientWorker, init: ProcessInit): void => {
    const { runtime } = client(worker, init);
    setRuntime(runtime);
    // Once the spawn that started it has returned.
    setImmediate(() => {
      void runShell(argv).then((status) => {
        // A shell that died of a signal has ended already.
        if (!worker.terminated) {
          worker.send({ type: "post", op: "proc.exit", args: [status] });
        }
      });
    });
  };
  const host: KernelHost = {
    createWorker() {
      const worker = new ClientWorker();
      // The first is the parent's, the second the shell's.
      if (workers.length === 1) {
        worker.onInit = (init) => startShell(worker, init);
      } else if (workers.length > 1) {
        worker.onInit = (init) => adoptChild(worker, init, children, options.programs ?? {});
      }
      workers.push(worker);
      return worker;
    },
    emit(event) {
      events.push(event);
    },
  };
  const vfs = new Vfs();
  const kernel = new Kernel(vfs, host, "app");
  writeFiles(vfs, options.files ?? {});
  const page = kernel.spawnFromPage("node", ["parent.js"], {});
  const parent = client(workers[0], workers[0].init!).runtime;
  parent.processes.onSignal(() => true);
  const handle = parent.processes.spawn({
    command: argv[0],
    args: argv.slice(1),
    cwd: parent.cwd,
    env: parent.env,
    stdio: options.stdio ?? ["inherit", "inherit", "inherit"],
  });
  const output = () => terminalOutput(events, page);
  return {
    kernel,
    pid: handle.pid,
    parent,
    stdio: handle.stdio,
    exit: new Promise((resolve) => parent.processes.onExit(handle.pid, resolve)),
    children: () => [...children],
    output,
    type: (text) => kernel.writeInput(page, text),
    waitFor: (text, ms = 3000) => shows(output, text, ms),
  };
}

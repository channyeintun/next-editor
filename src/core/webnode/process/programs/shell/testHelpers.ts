// Test support for the shell: runs `runShell` against the fake process
// runtime with a small filesystem and a scripted set of external commands.
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { Vfs } from "../../../kernel/vfs/vfs";
import type { SpawnRequest } from "../../runtime";
import { setRuntime } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import type { FakeChildIo, FakeRuntime } from "../../testing/fakeRuntime";
import { runShell } from "./index";

const encoder = new TextEncoder();

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
  setRuntime(rt);
  return { rt, vfs };
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

// Test kit for the `fs` tests: runs one scenario against webnode's `fs` (on a
// fake runtime over a real in-memory Vfs) and against the host's `node:fs` in
// a temporary directory, and reduces both outcomes to comparable data — values
// with the sandbox root replaced, errors as code/syscall/message.
import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import { setRuntime } from "../../runtime";
import webnodeFs from "../fs";

/** The `fs` surface a scenario uses: Node's own types describe both implementations. */
export type AnyFs = typeof nodeFs;

/** One implementation with a fresh directory to work in. */
export interface Side {
  name: "node" | "webnode";
  fs: AnyFs;
  /** Absolute sandbox root; scenario paths live under it. */
  root: string;
}

/** Both sides, plus the fake runtime behind webnode's. */
export interface Sides {
  node: Side;
  ours: Side;
  runtime: FakeRuntime;
  cleanup(): void;
}

/** Installs a fake runtime with `/work` as the working directory and makes a Node temp dir. */
export function makeSides(): Sides {
  const runtime = createFakeRuntime({ cwd: "/work" });
  runtime.vfs.mkdir("/work", false, 0o755);
  setRuntime(runtime);
  const root = nodeFs.mkdtempSync(nodePath.join(nodeFs.realpathSync(os.tmpdir()), "webnode-fs-"));
  return {
    node: { name: "node", fs: nodeFs, root },
    ours: { name: "webnode", fs: webnodeFs as unknown as AnyFs, root: "/work" },
    runtime,
    cleanup: () => {
      setRuntime(null);
      nodeFs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** What a scenario produced, reduced for comparison. */
export type Outcome = { value: unknown } | { error: ErrorShape };

export interface ErrorShape {
  code: unknown;
  syscall?: unknown;
  message: string;
  name: string;
}

function replaceRoot(text: string, root: string): string {
  return text.split(root).join("<root>");
}

/** Reduces `value` to plain data: Buffers as hex, Stats and Dirents as their essentials. */
export function normalize(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return replaceRoot(value, root);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value instanceof Uint8Array) {
    return `hex:${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`;
  }
  if (value instanceof Error) {
    return { error: errorShape(value, root) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, root));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.isFile === "function" && "name" in record && "parentPath" in record) {
      return {
        dirent: normalize(record.name, root),
        parentPath: normalize(record.parentPath, root),
        file: (record.isFile as () => boolean)(),
        dir: (record.isDirectory as () => boolean)(),
        link: (record.isSymbolicLink as () => boolean)(),
      };
    }
    if (typeof record.isFile === "function" && "mode" in record) {
      return {
        file: (record.isFile as () => boolean)(),
        dir: (record.isDirectory as () => boolean)(),
        link: (record.isSymbolicLink as () => boolean)(),
        size: (record.isDirectory as () => boolean)() ? "dir" : normalize(record.size, root),
        perm: Number(record.mode) & 0o777,
      };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      out[key] = normalize(item, root);
    }
    return out;
  }
  return value;
}

/** An error's comparable fields. */
export function errorShape(error: unknown, root: string): ErrorShape {
  const e = error as Error & { code?: unknown; syscall?: unknown };
  const shape: ErrorShape = {
    code: e.code,
    message: replaceRoot(String(e.message), root),
    name: e.name,
  };
  if (e.syscall !== undefined) {
    shape.syscall = e.syscall;
  }
  return shape;
}

/** Runs `run` on one side in its scenario directory. */
export function runSync(
  side: Side,
  dir: string,
  run: (fs: AnyFs, dir: string) => unknown,
): Outcome {
  try {
    return { value: normalize(run(side.fs, dir), side.root) };
  } catch (error) {
    return { error: errorShape(error, side.root) };
  }
}

/** Runs an async `run` on one side. */
export async function runAsync(
  side: Side,
  dir: string,
  run: (fs: AnyFs, dir: string) => Promise<unknown>,
): Promise<Outcome> {
  try {
    return { value: normalize(await run(side.fs, dir), side.root) };
  } catch (error) {
    return { error: errorShape(error, side.root) };
  }
}

/** Calls `fn` and returns its result, or the error's comparable shape: for collecting many steps in one scenario. */
export function attempt(fn: () => unknown): unknown {
  try {
    const value = fn();
    return value === undefined ? "ok" : value;
  } catch (error) {
    const e = error as { code?: unknown; syscall?: unknown };
    return { code: e.code, syscall: e.syscall };
  }
}

/** A fresh scenario directory on both sides. */
export function scenarioDirs(sides: Sides, name: string): { node: string; ours: string } {
  const node = `${sides.node.root}/${name}`;
  const ours = `${sides.ours.root}/${name}`;
  sides.node.fs.mkdirSync(node);
  sides.ours.fs.mkdirSync(ours);
  return { node, ours };
}

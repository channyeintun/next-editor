// @vitest-environment node
// A process's path calls on the shared filesystem: which go to the kernel (the
// /dev paths under any spelling, and whatever reaches a device through a link),
// that a call which changes a watched tree tells the kernel, that what a call
// creates is masked by the process's own mask, and that a worker whose module
// does not instantiate still works through the kernel.
import { afterEach, describe, expect, it } from "vitest";
import type { FsBackend } from "../process/runtime";
import { Kernel } from "../kernel/kernel";
import type { KernelHost, KernelWorker } from "../kernel/kernel";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../kernel/vfs/types";
import { createSharedFilesystem } from "./boot";
import type { SharedFilesystem } from "./boot";
import { kernelPathOf, normalizePath, withDirectPaths } from "./processBackend";
import { createUmaskCell, DEFAULT_UMASK, readUmask, writeUmask } from "../umask";

const WRITE = O_WRONLY | O_CREAT | O_TRUNC;
const encoder = new TextEncoder();

/** A kernel side that records each call it gets and answers with a marker. */
function recordingKernel(): { backend: FsBackend; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const backend = new Proxy({} as FsBackend, {
    get:
      (_target, name) =>
      (...args: unknown[]) => {
        calls.push([name, ...args]);
        return name === "exists" ? true : "from the kernel";
      },
  });
  return { backend, calls };
}

const stopped: (() => void)[] = [];

afterEach(() => {
  for (const stop of stopped.splice(0)) {
    stop();
  }
});

/** The shared filesystem with a kernel booted on it (which adds its device links). */
function boot(): {
  shared: SharedFilesystem;
  kernel: Kernel;
  /** A process's backend over `kernel`, with the mask `umask` reads (022 by default). */
  join: (kernel: FsBackend, umask?: () => number) => FsBackend;
} {
  const shared = createSharedFilesystem();
  if (shared === null) {
    throw new Error("no shared memory in this environment");
  }
  const host: KernelHost = {
    createWorker: () => ({ postMessage() {}, terminate() {} }) as unknown as KernelWorker,
    emit() {},
    sharedFs: shared,
  };
  const kernel = new Kernel(shared.fs, host, "app");
  stopped.push(() => kernel.dispose());
  const join = (backend: FsBackend, umask = () => DEFAULT_UMASK) => {
    const entry = shared.admit();
    if (entry === null) {
      throw new Error("no slot");
    }
    return withDirectPaths(
      backend,
      { module: shared.module, memory: shared.memory, ...entry },
      () => {},
      umask,
    );
  };
  return { shared, kernel, join };
}

/**
 * The kernel's own answers to path calls, as a process with no open files
 * gets them. `umask` is the process's mask as the kernel holds it.
 */
function kernelSide(kernel: Kernel, umask = createUmaskCell(DEFAULT_UMASK)): FsBackend {
  const handlers = (
    kernel as unknown as { handlers: Record<string, (...args: unknown[]) => unknown> }
  ).handlers;
  const proc = { pid: 1, fds: new Map(), owner: null, terminal: null, umask };
  return new Proxy({} as FsBackend, {
    get:
      (_target, name) =>
      (...args: unknown[]) =>
        handlers[`fs.${String(name)}`](proc, ...args),
  });
}

describe("kernel paths", () => {
  it("are /dev and what is under it, by the normalized path", () => {
    expect(kernelPathOf("/dev/null")).toBe("/dev/null");
    expect(kernelPathOf("//dev//null")).toBe("/dev/null");
    expect(kernelPathOf("/dev/./stdin")).toBe("/dev/stdin");
    expect(kernelPathOf("/tmp/../dev/null")).toBe("/dev/null");
    expect(kernelPathOf("/dev")).toBe("/dev");
    expect(kernelPathOf("/devices/x")).toBeNull();
    expect(kernelPathOf("/home/dev/null")).toBeNull();
    expect(kernelPathOf("/home/projects/app/src/index.ts")).toBeNull();
    expect(normalizePath("/a/b/../../..")).toBe("/");
  });
});

describe("withDirectPaths", () => {
  it("sends every spelling of a /dev path to the kernel", () => {
    const { join } = boot();
    const { backend, calls } = recordingKernel();
    const fs = join(backend);
    expect(fs.readFile("/dev/stdin")).toBe("from the kernel");
    fs.writeFile("//dev/null", encoder.encode("junk"), WRITE, 0o666);
    fs.writeFile("/tmp/../dev/stdout", encoder.encode("out"), WRITE, 0o666);
    expect(fs.exists("/dev/./null")).toBe(true);
    fs.rename("/tmp/a", "/dev/null");
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["readFile", "/dev/stdin"],
      ["writeFile", "//dev/null"],
      ["writeFile", "/tmp/../dev/stdout"],
      ["exists", "/dev/./null"],
      ["rename", "/tmp/a"],
    ]);
  });

  it("answers ordinary paths itself", () => {
    const { join } = boot();
    const { backend, calls } = recordingKernel();
    const fs = join(backend);
    fs.writeFile("/tmp/a.txt", encoder.encode("a"), WRITE, 0o644);
    expect(new TextDecoder().decode(fs.readFile("/tmp/a.txt"))).toBe("a");
    expect(fs.exists("/tmp/missing")).toBe(false);
    expect(() => fs.stat("/tmp/missing", true)).toThrow(/ENOENT/);
    expect(calls).toEqual([]);
  });

  it("sends a path that reaches a device through a link to the kernel, and creates no file", () => {
    const { shared, join } = boot();
    const { backend, calls } = recordingKernel();
    const fs = join(backend);
    fs.symlink("/dev/null", "/tmp/null-link");
    fs.symlink("/dev", "/tmp/dev-link");
    fs.writeFile("/tmp/null-link", encoder.encode("junk"), WRITE, 0o644);
    fs.writeFile("/tmp/dev-link/stdout", encoder.encode("junk"), WRITE, 0o644);
    expect(fs.exists("/tmp/null-link")).toBe(true);
    expect(fs.readFile("/tmp/dev-link/null")).toBe("from the kernel");
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["writeFile", "/tmp/null-link"],
      ["writeFile", "/tmp/dev-link/stdout"],
      ["exists", "/tmp/null-link"],
      ["readFile", "/tmp/dev-link/null"],
    ]);
    // The tree holds the kernel's link at each device, never a file.
    for (const name of ["null", "stdout"]) {
      expect(shared.fs.stat(`/dev/${name}`, false).mode & 0o170000).toBe(0o120000);
    }
  });

  it("gets the kernel's device for a link to /dev/null on the shared filesystem", () => {
    const { shared, kernel, join } = boot();
    const fs = join(kernelSide(kernel));
    fs.symlink("/dev/null", "/tmp/null-link");
    fs.symlink("/dev", "/tmp/dev-link");
    for (const path of ["/tmp/null-link", "/tmp/dev-link/null", "/dev//null"]) {
      fs.writeFile(path, encoder.encode("junk"), WRITE, 0o644);
      expect(fs.readFile(path).byteLength).toBe(0);
      expect(fs.exists(path)).toBe(true);
      expect(fs.stat(path, true).mode & 0o170000).toBe(0o020000);
      expect(fs.realpath(path)).toBe("/dev/null");
    }
    expect(shared.fs.stat("/dev/null", false).mode & 0o170000).toBe(0o120000);
    // A loop of links that is not a device is still one.
    fs.symlink("/tmp/loop", "/tmp/loop");
    expect(() => fs.readFile("/tmp/loop")).toThrow(/ELOOP/);
    expect(fs.exists("/tmp/loop")).toBe(false);
  });

  it("gives a device's own entry the device's answer by a path through a link", () => {
    const { kernel, join } = boot();
    const fs = join(kernelSide(kernel));
    fs.symlink("/", "/tmp/root");
    fs.symlink("/dev", "/tmp/dev-link");
    fs.symlink("/dev/null", "/tmp/null-link");
    const kind = (path: string) => fs.stat(path, false).mode & 0o170000;
    for (const prefix of ["", "/tmp/root", "/tmp/dev-link/.."]) {
      expect(kind(`${prefix}/dev/fd`)).toBe(0o040000);
      expect(kind(`${prefix}/dev/null`)).toBe(0o020000);
      expect(() => fs.readlink(`${prefix}/dev/stdout`)).toThrow(/EINVAL/);
    }
    // A link of the user's to a device stays a link.
    expect(kind("/tmp/null-link")).toBe(0o120000);
    expect(fs.readlink("/tmp/null-link")).toBe("/dev/null");
  });

  it("tells the kernel when a call changed a watched tree", () => {
    const { shared } = boot();
    shared.fs.mkdir("/w", true, 0o755);
    stopped.push(shared.fs.watch("/w", true, () => {}));
    const entry = shared.admit()!;
    let notified = 0;
    const { backend } = recordingKernel();
    const fs = withDirectPaths(
      backend,
      { module: shared.module, memory: shared.memory, ...entry },
      () => (notified += 1),
      () => DEFAULT_UMASK,
    );
    fs.writeFile("/w/a.txt", encoder.encode("a"), WRITE, 0o644);
    expect(notified).toBe(1);
    fs.readFile("/w/a.txt");
    expect(notified).toBe(1);
  });

  it("works through the kernel alone when the module does not instantiate", () => {
    const { shared } = boot();
    const { backend } = recordingKernel();
    // The smallest valid module: none of the filesystem's exports.
    const empty = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const fs = withDirectPaths(
      backend,
      { module: empty, memory: shared.memory, slot: 0, token: 0 },
      () => {},
      () => DEFAULT_UMASK,
    );
    expect(fs).toBe(backend);
  });

  it("creates under the process's mask, as it is at each call", () => {
    const { shared, kernel, join } = boot();
    const cell = createUmaskCell(0o077);
    const perm = (path: string) => shared.fs.stat(path, false).mode & 0o7777;
    const viaKernel = kernelSide(kernel, cell);
    const fs = join(viaKernel, () => readUmask(cell));
    fs.writeFile("/tmp/f", encoder.encode("x"), WRITE, 0o666);
    fs.mkdir("/tmp/d", false, 0o777);
    expect(fs.mkdir("/tmp/r/s", true, 0o777)).toBe("/tmp/r");
    const temp = fs.mkdtemp("/tmp/t-");
    // A descriptor is the kernel's to open, and it reads the same mask.
    viaKernel.open("/tmp/o", O_WRONLY | O_CREAT, 0o666);
    expect(["/tmp/f", "/tmp/d", "/tmp/r", "/tmp/r/s", temp, "/tmp/o"].map(perm)).toEqual([
      0o600, 0o700, 0o700, 0o700, 0o700, 0o600,
    ]);
    // Set again, the next call is under the new one.
    writeUmask(cell, 0o002);
    fs.writeFile("/tmp/g", encoder.encode("x"), WRITE, 0o666);
    viaKernel.open("/tmp/o2", O_WRONLY | O_CREAT, 0o666);
    expect([perm("/tmp/g"), perm("/tmp/o2")]).toEqual([0o664, 0o664]);
    // mkdtemp asks for 0700, which only a mask on the owner's bits shows.
    writeUmask(cell, 0o277);
    expect(perm(fs.mkdtemp("/tmp/u-"))).toBe(0o500);
    // A copy keeps its source's mode, and a link is 0777, whatever the mask.
    writeUmask(cell, 0o777);
    fs.chmod("/tmp/f", 0o755, true);
    fs.copyFile("/tmp/f", "/tmp/copy", 0);
    fs.symlink("/tmp/f", "/tmp/link");
    expect([perm("/tmp/copy"), perm("/tmp/link")]).toEqual([0o755, 0o777]);
  });

  it("keeps each caller's mask its own on the one shared memory", () => {
    const { shared, kernel, join } = boot();
    const perm = (path: string) => shared.fs.stat(path, false).mode & 0o7777;
    const strict = join(kernelSide(kernel), () => 0o077);
    const open = join(kernelSide(kernel), () => 0);
    strict.writeFile("/tmp/s1", encoder.encode("x"), WRITE, 0o666);
    open.writeFile("/tmp/o1", encoder.encode("x"), WRITE, 0o666);
    // The kernel's instance, for the page: the default mask, whoever called last.
    shared.fs.privileged.writeFile("/tmp/page", encoder.encode("x"), WRITE, 0o644);
    shared.fs.privileged.mkdir("/tmp/pagedir", false, 0o755);
    strict.mkdir("/tmp/s2", false, 0o777);
    shared.fs.writeFile("/tmp/kernel", encoder.encode("x"), WRITE, 0o666);
    open.mkdir("/tmp/o2", false, 0o777);
    expect(
      ["s1", "o1", "page", "pagedir", "s2", "kernel", "o2"].map((name) => perm(`/tmp/${name}`)),
    ).toEqual([0o600, 0o666, 0o644, 0o755, 0o700, 0o644, 0o777]);
  });
});

// @vitest-environment node
// Running out of memory: on a small shared memory, filling the filesystem
// ends in ENOSPC for the call that did not fit, never in a trap that poisons
// the filesystem (EIO for every process). What was there stays intact, and
// removing makes the room usable again.
import { describe, expect, it } from "vitest";
import type { SystemError } from "../errors";
import { O_APPEND, O_CREAT, O_RDWR, O_TRUNC, O_WRONLY } from "../kernel/vfs/types";
import { createSharedFilesystem, type SharedFilesystem } from "./boot";
import { SharedFs } from "./sharedFs";

const WRITE = O_WRONLY | O_CREAT | O_TRUNC;
/** 32 MiB: small enough to fill in a moment. */
const PAGES = 512;

function bootShared(): SharedFilesystem {
  const shared = createSharedFilesystem({ maximumPages: PAGES });
  if (shared === null) {
    throw new Error("this engine cannot make the shared filesystem");
  }
  return shared;
}

function boot(): SharedFs {
  return bootShared().fs;
}

/** The error `action` throws, or null when it succeeds. */
function caught(action: () => unknown): SystemError | null {
  try {
    action();
    return null;
  } catch (error) {
    return error as SystemError;
  }
}

/** "ok", or the code of the error `action` throws. */
function outcome(action: () => unknown): string {
  return caught(action)?.code ?? "ok";
}

/** Bytes that differ by file and by position, so a mixed-up file shows. */
function content(id: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (id * 31 + i * 7) & 0xff;
  }
  return bytes;
}

/** Writes files of `size` bytes under `dir` until one does not fit; returns how many did. */
function fill(fs: SharedFs, dir: string, size: number, start = 0): number {
  let id = start - 1;
  let error: SystemError | null = null;
  while (error === null) {
    id += 1;
    error = caught(() => fs.writeFile(`${dir}/f${id}`, content(id, size), WRITE, 0o644));
  }
  expect(error.code).toBe("ENOSPC");
  // The file that did not fit is not left behind, half made.
  expect(fs.exists(`${dir}/f${id}`)).toBe(false);
  return id - start;
}

function expectHealthy(fs: SharedFs): void {
  expect(fs.stat("/", true).mode & 0o170000).toBe(0o040000);
  expect(fs.check()).toBe(0);
}

// Each case fills the memory to its limit, seconds of work on a busy machine.
describe("SharedFs when memory runs out", { timeout: 60_000 }, () => {
  it("fails a write with ENOSPC and keeps everything written before", () => {
    const fs = boot();
    fs.mkdir("/data", false, 0o755);
    const size = 200_000;
    const written = fill(fs, "/data", size);
    expect(written).toBeGreaterThan(50);

    const error = caught(() => fs.writeFile("/data/more", content(0, size), WRITE, 0o644));
    expect(error?.code).toBe("ENOSPC");
    expect(["open", "write"]).toContain(error?.syscall);
    expectHealthy(fs);
    for (let id = 0; id < written; id += 1) {
      expect(fs.readFile(`/data/f${id}`)).toEqual(content(id, size));
    }
    expect(fs.totals()).toEqual({ inodes: 2 + written, bytes: written * size });
  });

  it("keeps every other operation to success or ENOSPC while full", () => {
    const fs = boot();
    fs.mkdir("/data", false, 0o755);
    fill(fs, "/data", 200_000);
    // Then the last of it with small files: now the headroom itself is all that is left.
    const small = fill(fs, "/data", 1000, 100_000);
    expect(small).toBeGreaterThan(0);

    const outcomes: Record<string, string> = {
      mkdir: outcome(() => fs.mkdir("/new-dir", false, 0o755)),
      mkdirp: outcome(() => fs.mkdir("/a/b/c/d", true, 0o755)),
      empty: outcome(() => fs.writeFile("/empty", new Uint8Array(0), WRITE, 0o644)),
      symlink: outcome(() => fs.symlink("/data/f0", "/link")),
      link: outcome(() => fs.link("/data/f0", "/hard")),
      rename: outcome(() => fs.rename("/data/f1", "/data/renamed")),
      copy: outcome(() => fs.copyFile("/data/f2", "/copy", 0)),
      mkdtemp: outcome(() => fs.mkdtemp("/tmp-")),
      open: outcome(() => fs.open("/opened", O_RDWR | O_CREAT, 0o644).close()),
      grow: outcome(() => fs.truncate("/data/f3", 300_000)),
    };
    for (const code of Object.values(outcomes)) {
      expect(["ok", "ENOSPC"]).toContain(code);
    }
    // A copy of 200 kB cannot fit in what is left.
    expect(outcomes.copy).toBe("ENOSPC");
    expectHealthy(fs);

    // Reading needs no room.
    expect(fs.readFile("/data/f0")).toEqual(content(0, 200_000));
    expect(fs.readdir("/data").length).toBeGreaterThan(small);
    expect(fs.stat("/data/f4", true).size).toBe(200_000);
    expect(fs.exists(outcomes.rename === "ok" ? "/data/renamed" : "/data/f1")).toBe(true);
    const file = fs.open("/data/f5", O_RDWR, 0);
    expect(file.read(4, 0)).toEqual(content(5, 4));
    file.close();
    expectHealthy(fs);
  });

  it("makes room again on rm, the same room every time", () => {
    const shared = bootShared();
    const fs = shared.fs;
    const counts: number[] = [];
    const sizes: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      fs.mkdir("/data", false, 0o755);
      counts.push(fill(fs, "/data", 150_000));
      expectHealthy(fs);
      fs.rm("/data", true, false);
      expectHealthy(fs);
      expect(fs.totals()).toEqual({ inodes: 1, bytes: 0 });
      sizes.push(shared.memory.buffer.byteLength);
    }
    for (const count of counts) {
      expect(Math.abs(count - counts[0])).toBeLessThanOrEqual(2);
    }
    expect(new Set(sizes).size).toBe(1);
  });

  it("runs out of room for metadata alone, and rm -r recovers", () => {
    const fs = boot();
    let made = 0;
    let dirs = 0;
    let error: SystemError | null = null;
    for (let dir = 0; error === null; dir += 1) {
      error = caught(() => fs.mkdir(`/m${dir}`, false, 0o755));
      dirs += error === null ? 1 : 0;
      for (let file = 0; error === null && file < 500; file += 1) {
        error = caught(() => fs.writeFile(`/m${dir}/${file}`, new Uint8Array(0), WRITE, 0o644));
        made += error === null ? 1 : 0;
      }
    }
    expect(error?.code).toBe("ENOSPC");
    expect(made).toBeGreaterThan(20_000);
    expectHealthy(fs);
    expect(fs.totals().inodes).toBe(1 + made + dirs);
    const removeAll = () => {
      for (const entry of fs.readdir("/")) {
        fs.rm(`/${entry.name}`, true, false);
      }
      expectHealthy(fs);
      expect(fs.totals()).toEqual({ inodes: 1, bytes: 0 });
    };
    removeAll();
    // The inode table keeps its size, but the files' room is had again. The
    // check then has too little memory left to look (it answers 1): only
    // once it is emptied again.
    expect(fill(fs, "", 100_000)).toBeGreaterThan(100);
    expect(fs.stat("/", true).nlink).toBe(2);
    removeAll();
  });

  it("grows one file by appends until ENOSPC, and truncating it makes the room usable", () => {
    const fs = boot();
    const chunk = content(1, 64 * 1024);
    const append = (): number => {
      const file = fs.open("/big", O_WRONLY | O_CREAT | O_APPEND, 0o644);
      let error: SystemError | null = null;
      while (error === null) {
        error = caught(() => file.write(chunk, null));
      }
      expect(error?.code).toBe("ENOSPC");
      expect(error?.syscall).toBe("write");
      file.close();
      return fs.stat("/big", true).size;
    };
    const first = append();
    expect(first).toBeGreaterThan(8 * 1024 * 1024);
    expectHealthy(fs);
    expect(fs.totals()).toEqual({ inodes: 2, bytes: first });

    fs.truncate("/big", 0);
    expectHealthy(fs);
    expect(append()).toBeGreaterThanOrEqual(first);
    fs.truncate("/big", 0);
    fs.unlink("/big");
    expect(fill(fs, "", 100_000)).toBeGreaterThan(100);
    expectHealthy(fs);
  });

  it("does not poison while a watch logs every change", () => {
    const fs = boot();
    let events = 0;
    const stop = fs.watch("/", true, () => {
      events += 1;
    });
    fs.mkdir("/data", false, 0o755);
    const written = fill(fs, "/data", 100_000);
    fill(fs, "/data", 100, 100_000);
    expectHealthy(fs);
    expect(events).toBeGreaterThan(written);
    fs.rm("/data", true, false);
    expectHealthy(fs);
    stop();
  });

  it("tells the watchers something changed when an event was lost for want of memory", () => {
    const shared = bootShared();
    const kernel = shared.fs;
    const entry = shared.admit();
    if (entry === null) {
      throw new Error("no free slot");
    }
    const process = new SharedFs({
      module: shared.module,
      memory: shared.memory,
      now: Date.now,
      entry,
      deliversEvents: false,
    });
    kernel.mkdir("/watched", false, 0o755);
    kernel.writeFile("/watched/file", content(1, 10), WRITE, 0o644);
    kernel.mkdir("/data", false, 0o755);
    for (let id = 0; id < 400; id += 1) {
      kernel.writeFile(`/data/spare${id}`, new Uint8Array(0), WRITE, 0o644);
    }
    // Fill it with nothing watching, so the event log has no room of its own,
    // then use up the last of the memory in ever smaller pieces.
    fill(kernel, "/data", 200_000);
    let spare = 0;
    for (const size of [65_536, 4096, 256, 16, 1]) {
      while (outcome(() => kernel.truncate(`/data/spare${spare}`, size)) === "ok") {
        spare += 1;
      }
    }
    expect(spare).toBeLessThan(400);

    const seen: string[] = [];
    const stop = kernel.watch("/watched", true, (event) => {
      seen.push(`${event.eventType} ${event.path}`);
    });

    // A process changes the watched file. The change is made; its event has
    // nowhere to go, so the log stays empty and only the mark is set.
    process.chmod("/watched/file", 0o600, true);
    expect(process.stat("/watched/file", true).mode & 0o777).toBe(0o600);
    expect(seen).toEqual([]);
    // That is still something for the kernel to deliver: it is told ...
    expect(process.takeEventsPending()).toBe(true);
    // ... and says so to every watch, since it cannot say what changed.
    kernel.drainEvents();
    expect(seen).toEqual(["rename /watched"]);

    // The same for a change the kernel makes itself.
    kernel.chmod("/watched/file", 0o640, true);
    expect(seen).toEqual(["rename /watched", "rename /watched"]);

    // With room again an event arrives as itself. (Removing may lose events
    // of its own before it has freed enough, and says so the same way.)
    kernel.rm("/data", true, false);
    const before = seen.length;
    process.chmod("/watched/file", 0o644, true);
    expect(process.takeEventsPending()).toBe(true);
    kernel.drainEvents();
    expect(seen.slice(before)).toEqual(["change /watched/file"]);
    stop();
    expectHealthy(kernel);
  });
});

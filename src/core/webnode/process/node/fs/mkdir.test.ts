// @vitest-environment node
// What `fs.mkdir` with `recursive` asks of the filesystem, and that asking for
// a whole path at once changes nothing Node's steps would do. The steps'
// results and errors are compared with Node's in permissions.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { Vfs } from "../../../kernel/vfs/vfs";
import { setRuntime } from "../../runtime";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import { mkdirAsync, mkdirpBySteps, mkdirSync } from "./mkdir";

afterEach(() => {
  setRuntime(null);
});

const FORMS = [
  ["sync", mkdirSync],
  ["async", mkdirAsync],
] as const;

describe.each(FORMS)("what mkdir with recursive asks of the filesystem (%s)", (_form, mkdir) => {
  let rt: FakeRuntime;
  /** Every request made of the filesystem, and how many were refused. */
  let requests: string[];
  let refused: number;

  beforeEach(() => {
    rt = createFakeRuntime({ cwd: "/work" });
    rt.vfs.mkdir("/work/there/a/b", true, 0o755);
    setRuntime(rt);
    requests = [];
    refused = 0;
    for (const name of ["mkdir", "stat", "exists", "access"] as const) {
      const real = rt.fs[name] as (...args: unknown[]) => unknown;
      Object.assign(rt.fs, {
        [name]: (...args: unknown[]) => {
          requests.push(`${name} ${String(args[0])}`);
          try {
            return real(...args);
          } catch (error) {
            refused++;
            throw error;
          }
        },
      });
    }
  });

  it("asks once, and is refused nothing, for a directory that is there", () => {
    expect(mkdir("there/a/b", { recursive: true })).toBeUndefined();
    expect(mkdir("/work/there/a/b", { recursive: true })).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(refused).toBe(0);
  });

  it("is refused nothing making directories below one that is there", () => {
    expect(mkdir("there/a/n1/n2/n3/n4", { recursive: true })).toBe("there/a/n1");
    expect(mkdir("/work/there/a/m1/m2/m3", { recursive: true })).toBe("/work/there/a/m1");
    expect(mkdir("there/a/b/c", { recursive: true })).toBe("there/a/b/c");
    expect(refused).toBe(0);
    expect(requests.filter((request) => request.startsWith("mkdir "))).toHaveLength(3);
    for (const made of ["n1/n2/n3/n4", "m1/m2/m3", "b/c"]) {
      expect(rt.vfs.stat(`/work/there/a/${made}`, true).mode & 0o777).toBe(0o755);
    }
  });

  it("asks once making a new relative path, as for an absolute one", () => {
    expect(mkdir("there/new", { recursive: true })).toBe("there/new");
    expect(mkdir("fresh/a/b", { recursive: true })).toBe("fresh");
    expect(mkdir("/work/abs/c", { recursive: true })).toBe("/work/abs");
    expect(requests).toEqual([
      "mkdir /work/there/new",
      "mkdir /work/fresh/a/b",
      "mkdir /work/abs/c",
    ]);
    expect(refused).toBe(0);
  });

  it("makes nothing above a working directory that is gone", () => {
    rt.vfs.rm("/work", true, false);
    expect(() => mkdir("x/y", { recursive: true })).toThrow(
      expect.objectContaining({ code: "ENOENT", syscall: "mkdir" }),
    );
    expect(rt.vfs.exists("/work")).toBe(false);
  });
});

/** A deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every entry below `path` with its kind and mode, in order. */
function listing(vfs: Vfs, path: string, out: string[] = []): string[] {
  const view = vfs.privileged;
  for (const entry of view.readdir(path)) {
    const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    const mode = view.stat(child, false).mode.toString(8);
    out.push(`${child} ${entry.type} ${mode}`);
    if (entry.type === "dir") {
      listing(vfs, child, out);
    }
  }
  return out;
}

/** What a call returned or threw, as comparable data. */
function outcome(run: () => unknown): unknown {
  try {
    return { returned: run() };
  } catch (error) {
    const { code, syscall, path, message } = error as NodeJS.ErrnoException;
    return { code, syscall, path, message };
  }
}

describe("mkdir with recursive against MKDirp's own steps", () => {
  const NAMES = ["a", "b", "c", "f", "l", "dl", "ro", "nx"];
  const PARTS = [...NAMES, ...NAMES, ".", "..", ""];

  /** A tree with a file, links, and directories that refuse writing or searching. */
  function world(): FakeRuntime {
    const rt = createFakeRuntime({ cwd: "/work" });
    const { vfs } = rt;
    vfs.mkdir("/work/a/b", true, 0o755);
    vfs.mkdir("/work/ro/a", true, 0o755);
    vfs.mkdir("/work/nx/a", true, 0o755);
    vfs.writeFile("/work/f", new Uint8Array(0), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    vfs.writeFile("/work/a/f", new Uint8Array(0), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    vfs.symlink("a", "/work/l");
    vfs.symlink("missing", "/work/dl");
    vfs.symlink("/work/dl", "/work/a/dl");
    vfs.chmod("/work/ro", 0o555, true);
    vfs.chmod("/work/nx", 0o600, true);
    return rt;
  }

  it.each(["sync", "async"] as const)("does what the steps do (%s)", (form) => {
    const next = random(form === "sync" ? 11 : 12);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const mkdir = form === "sync" ? mkdirSync : mkdirAsync;
    let atOnce = 0;
    for (let round = 0; round < 400; round++) {
      const ours = world();
      const steps = world();
      for (let call = 0; call < 6; call++) {
        const parts = Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(PARTS));
        const path = (next() < 0.3 ? "/work/" : "") + parts.join("/");
        const mode = pick([0o777, 0o777, 0o755, 0o555, 0o300]);
        setRuntime(ours);
        const got = outcome(() => mkdir(path, { recursive: true, mode }));
        setRuntime(steps);
        const expected = outcome(() => mkdirpBySteps(steps.fs, path, mode, form));
        expect([path, got]).toEqual([path, expected]);
        expect(listing(ours.vfs, "/")).toEqual(listing(steps.vfs, "/"));
        if (!/(^|\/)\.{0,2}(\/|$)/.test(path) && "returned" in (got as object)) {
          atOnce++;
        }
      }
    }
    // Enough of the calls were ones a single request serves.
    expect(atOnce).toBeGreaterThan(300);
  });
});

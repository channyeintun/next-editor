// @vitest-environment node
// The sync `fs` API, scenario by scenario against the host's real `node:fs`:
// each scenario runs on both, and the results and error code/syscall/message
// must match. Where Linux and the macOS host differ, the scenario states the
// Linux (and so webnode) outcome instead.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "./fs";
import {
  attempt,
  makeSides,
  runSync,
  scenarioDirs,
  type AnyFs,
  type Sides,
} from "./fs/compare.testkit";

interface Scenario {
  name: string;
  run: (fs: AnyFs, dir: string) => unknown;
  /** The Linux outcome, checked instead of the host's when the host is not Linux. */
  linux?: unknown;
  /** Node 22's outcome, where the host's newer Node behaves differently. */
  node22?: unknown;
}

let sides: Sides;

beforeEach(() => {
  sides = makeSides();
});

afterEach(() => {
  sides.cleanup();
});

/** Runs `scenario` on both sides: webnode's outcome and the one it must equal. */
function outcomes(scenario: Scenario): { ours: unknown; expected: unknown } {
  const dirs = scenarioDirs(sides, scenario.name.replace(/\W+/g, "_"));
  const ours = runSync(sides.ours, dirs.ours, scenario.run);
  if (scenario.node22 !== undefined) {
    return { ours, expected: scenario.node22 };
  }
  if (scenario.linux !== undefined && process.platform !== "linux") {
    return { ours, expected: scenario.linux };
  }
  return { ours, expected: runSync(sides.node, dirs.node, scenario.run) };
}

const FLAGS = ["r", "r+", "rs+", "w", "wx", "w+", "wx+", "a", "ax", "a+", "ax+", "as", "as+"];

function sorted<T>(list: T[]): T[] {
  return [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const scenarios: Scenario[] = [
  {
    name: "open flags matrix",
    run: (f, d) =>
      FLAGS.map((flag) => {
        const results: Record<string, unknown> = { flag };
        for (const existing of [true, false]) {
          const file = `${d}/${flag}-${existing}`;
          if (existing) {
            f.writeFileSync(file, "hello");
          }
          const steps: unknown[] = [];
          let fd = -1;
          steps.push(
            attempt(() => {
              fd = f.openSync(file, flag);
            }),
          );
          if (fd >= 0) {
            steps.push(attempt(() => f.writeSync(fd, "AB")));
            steps.push(attempt(() => f.readFileSync(fd, "utf8")));
            const buf = Buffer.alloc(10);
            steps.push(attempt(() => buf.toString("utf8", 0, f.readSync(fd, buf, 0, 10, 0))));
            f.closeSync(fd);
          }
          steps.push(attempt(() => f.readFileSync(file, "utf8")));
          results[existing ? "existing" : "missing"] = steps;
        }
        return results;
      }),
  },
  {
    name: "numeric flags and default mode",
    run: (f, d) => {
      const c = f.constants;
      const fd = f.openSync(`${d}/n`, c.O_WRONLY | c.O_CREAT | c.O_TRUNC);
      f.writeSync(fd, "abc");
      f.closeSync(fd);
      const fd2 = f.openSync(`${d}/n`, c.O_RDWR | c.O_APPEND);
      f.writeSync(fd2, "de");
      f.closeSync(fd2);
      return [
        f.readFileSync(`${d}/n`, "latin1"),
        f.statSync(`${d}/n`).mode & 0o777,
        attempt(() => f.openSync(`${d}/n`, c.O_CREAT | c.O_EXCL | c.O_WRONLY)),
        attempt(() => f.openSync(`${d}/n/`, "r")),
        attempt(() => f.openSync(d, "r+")),
      ];
    },
  },
  {
    name: "read and write positions",
    run: (f, d) => {
      const file = `${d}/p`;
      f.writeFileSync(file, "abcdef");
      const fd = f.openSync(file, "r+");
      const out: unknown[] = [];
      out.push(f.writeSync(fd, "XY", 2));
      const buf = Buffer.alloc(8);
      out.push(f.readSync(fd, buf, 0, 3, null), buf.toString("latin1", 0, 3));
      out.push(f.readSync(fd, buf, 0, 2, 4), buf.toString("latin1", 0, 2));
      out.push(f.readSync(fd, buf, 0, 2, null), buf.toString("latin1", 0, 2));
      out.push(
        f.readSync(fd, buf, { offset: 1, length: 2, position: 0 }),
        buf.toString("latin1", 0, 3),
      );
      out.push(
        f.readSync(fd, buf, { position: 5n as unknown as number }),
        buf.toString("latin1", 0, 1),
      );
      out.push(f.writeSync(fd, Buffer.from("123456"), 1, 3, 0));
      out.push(
        (f.writeSync as (...args: unknown[]) => number)(fd, Buffer.from("Z"), { position: 10 }),
      );
      out.push(f.readSync(fd, buf));
      out.push(f.writeSync(fd, new Uint16Array([0x4241])));
      out.push(f.readvSync(fd, [Buffer.alloc(2), Buffer.alloc(3)], 0));
      out.push(f.writevSync(fd, [Buffer.from("q"), Buffer.from("rs")], 1));
      f.closeSync(fd);
      out.push(f.readFileSync(file));
      return out;
    },
  },
  {
    name: "append",
    run: (f, d) => {
      const file = `${d}/a`;
      f.appendFileSync(file, "one");
      f.appendFileSync(file, Buffer.from("two"));
      f.appendFileSync(file, "74687265", "hex");
      const fd = f.openSync(file, "a");
      f.appendFileSync(fd, "!");
      f.closeSync(fd);
      return f.readFileSync(file, "utf8");
    },
  },
  {
    name: "pwrite on an append fd",
    run: (f, d) => {
      const file = `${d}/ap`;
      f.writeFileSync(file, "abc");
      const fd = f.openSync(file, "a");
      f.writeSync(fd, "Z", 0);
      f.closeSync(fd);
      return f.readFileSync(file, "utf8");
    },
    linux: { value: "abcZ" },
  },
  {
    name: "truncate",
    run: (f, d) => {
      const file = `${d}/t`;
      f.writeFileSync(file, "abcdef");
      const out: unknown[] = [];
      f.truncateSync(file, 3);
      out.push(f.readFileSync(file, "latin1"));
      f.truncateSync(file, 5);
      out.push(f.readFileSync(file));
      f.truncateSync(file, -4);
      out.push(f.statSync(file).size);
      f.writeFileSync(file, "xyz");
      const fd = f.openSync(file, "r+");
      f.ftruncateSync(fd, 1);
      f.closeSync(fd);
      out.push(f.readFileSync(file, "latin1"));
      f.truncateSync(file);
      out.push(f.statSync(file).size);
      out.push(attempt(() => f.truncateSync(d, 0)));
      out.push(attempt(() => f.truncateSync(`${d}/nope`, 0)));
      return out;
    },
  },
  {
    name: "readdir options",
    run: (f, d) => {
      f.mkdirSync(`${d}/a/b/c`, { recursive: true });
      f.writeFileSync(`${d}/a/z.txt`, "");
      f.writeFileSync(`${d}/a/b/c/deep.txt`, "");
      f.symlinkSync("b", `${d}/a/link`);
      return [
        sorted(f.readdirSync(`${d}/a`)),
        sorted(f.readdirSync(`${d}/a`, { withFileTypes: true }) as unknown[]),
        sorted(f.readdirSync(`${d}/a`, { recursive: true }) as string[]),
        sorted(f.readdirSync(`${d}/a`, { recursive: true, withFileTypes: true }) as unknown[]),
        sorted(f.readdirSync(`${d}/a`, "buffer") as unknown[]),
        sorted(f.readdirSync(`${d}/a`, { encoding: "hex" })),
        attempt(() => f.readdirSync(`${d}/a/z.txt`)),
        attempt(() => f.readdirSync(`${d}/missing`)),
      ];
    },
  },
  {
    name: "mkdir recursive return values",
    run: (f, d) => [
      f.mkdirSync(`${d}/x/y/z`, { recursive: true }),
      f.mkdirSync(`${d}/x/y/z`, { recursive: true }),
      f.mkdirSync(`${d}/x/y/w`, { recursive: true }),
      f.mkdirSync(`${d}/plain`),
      attempt(() => f.mkdirSync(`${d}/plain`)),
      attempt(() => f.mkdirSync(`${d}/missing/child`)),
      (f.writeFileSync(`${d}/file`, ""), attempt(() => f.mkdirSync(`${d}/file/sub`))),
      attempt(() => f.mkdirSync(`${d}/file/sub`, { recursive: true })),
      attempt(() => f.mkdirSync(`${d}/file`, { recursive: true })),
      f.mkdirSync(`${d}/moded`, 0o700),
      f.statSync(`${d}/moded`).mode & 0o777,
    ],
  },
  {
    name: "rm variants",
    run: (f, d) => {
      f.mkdirSync(`${d}/tree/sub`, { recursive: true });
      f.writeFileSync(`${d}/tree/sub/f`, "");
      f.writeFileSync(`${d}/file`, "");
      return [
        attempt(() => f.rmSync(`${d}/tree`)),
        attempt(() => f.rmSync(`${d}/missing`)),
        attempt(() => f.rmSync(`${d}/missing`, { force: true })),
        attempt(() => f.rmSync(`${d}/file/x`, { force: true })),
        attempt(() => f.rmdirSync(`${d}/tree`)),
        attempt(() => f.rmdirSync(`${d}/file`)),
        attempt(() => f.rmSync(`${d}/file`)),
        f.existsSync(`${d}/file`),
        attempt(() => f.rmSync(`${d}/tree`, { recursive: true })),
        f.existsSync(`${d}/tree`),
        attempt(() => f.rmSync(`${d}/tree`, { recursive: true, force: true })),
      ];
    },
  },
  {
    name: "rm a directory without recursive",
    run: (f, d) => {
      f.mkdirSync(`${d}/dir`);
      f.rmSync(`${d}/dir`);
    },
  },
  {
    name: "unlink a directory",
    run: (f, d) => f.unlinkSync(d),
    linux: {
      error: {
        code: "EISDIR",
        syscall: "unlink",
        message: "EISDIR: illegal operation on a directory, unlink '<root>/unlink_a_directory'",
        name: "Error",
      },
    },
  },
  {
    name: "rename edge cases",
    run: (f, d) => {
      f.mkdirSync(`${d}/dir/sub`, { recursive: true });
      f.mkdirSync(`${d}/full`);
      f.writeFileSync(`${d}/full/x`, "");
      f.writeFileSync(`${d}/a`, "A");
      f.writeFileSync(`${d}/b`, "B");
      return [
        attempt(() => f.renameSync(`${d}/a`, `${d}/b`)),
        f.readFileSync(`${d}/b`, "utf8"),
        f.existsSync(`${d}/a`),
        attempt(() => f.renameSync(`${d}/dir`, `${d}/dir/sub/inner`)),
        attempt(() => f.renameSync(`${d}/b`, `${d}/dir`)),
        attempt(() => f.renameSync(`${d}/dir`, `${d}/b`)),
        attempt(() => f.renameSync(`${d}/nope`, `${d}/c`)),
        attempt(() => f.renameSync(`${d}/dir`, `${d}/full`)),
        attempt(() => f.renameSync(`${d}/b`, `${d}/b`)),
        attempt(() => f.renameSync(`${d}/dir/sub`, `${d}/moved`)),
        f.readdirSync(`${d}/dir`),
      ];
    },
  },
  {
    name: "rename error message",
    run: (f, d) => f.renameSync(`${d}/nope`, `${d}/c`),
  },
  {
    name: "symlink readlink realpath lstat",
    run: (f, d) => {
      f.mkdirSync(`${d}/real/inner`, { recursive: true });
      f.writeFileSync(`${d}/real/inner/f.txt`, "data");
      f.symlinkSync("real/inner", `${d}/rel`);
      f.symlinkSync(`${d}/real`, `${d}/abs`);
      f.symlinkSync("nowhere", `${d}/dangling`);
      f.linkSync(`${d}/real/inner/f.txt`, `${d}/hard`);
      return [
        f.readlinkSync(`${d}/rel`),
        f.readlinkSync(`${d}/rel`, "buffer"),
        f.lstatSync(`${d}/rel`).isSymbolicLink(),
        f.statSync(`${d}/rel`).isDirectory(),
        f.realpathSync(`${d}/rel/f.txt`),
        f.realpathSync.native(`${d}/abs/inner/../inner/f.txt`),
        f.realpathSync(`${d}/abs/inner/..`),
        f.readFileSync(`${d}/rel/f.txt`, "utf8"),
        f.statSync(`${d}/hard`).nlink,
        attempt(() => f.statSync(`${d}/dangling`)),
        f.lstatSync(`${d}/dangling`).isSymbolicLink(),
        f.existsSync(`${d}/dangling`),
        attempt(() => f.readlinkSync(`${d}/real`)),
        attempt(() => f.symlinkSync("x", `${d}/rel`)),
        attempt(() => f.linkSync(`${d}/real`, `${d}/dirlink`)),
        attempt(() => f.linkSync(`${d}/nope`, `${d}/x`)),
        attempt(() => f.realpathSync(`${d}/missing/deeper`)),
        attempt(() => f.realpathSync.native(`${d}/missing`)),
        attempt(() => f.realpathSync(`${d}/dangling`)),
      ];
    },
  },
  {
    name: "realpath error messages",
    run: (f, d) => [
      runError(() => f.realpathSync(`${d}/missing/deeper`)),
      runError(() => f.realpathSync.native(`${d}/missing`)),
      runError(() => f.readlinkSync(d)),
      runError(() => f.symlinkSync("t", d)),
    ],
  },
  {
    name: "copyFile",
    run: (f, d) => {
      f.writeFileSync(`${d}/src`, "copy me", { mode: 0o640 });
      return [
        attempt(() => f.copyFileSync(`${d}/src`, `${d}/dst`)),
        f.readFileSync(`${d}/dst`, "utf8"),
        f.statSync(`${d}/dst`).mode & 0o777,
        attempt(() => f.copyFileSync(`${d}/src`, `${d}/dst`, f.constants.COPYFILE_EXCL)),
        attempt(() => f.copyFileSync(`${d}/nope`, `${d}/x`)),
        attempt(() => f.copyFileSync(`${d}/src`, `${d}/dst`, f.constants.COPYFILE_FICLONE)),
        runError(() => f.copyFileSync(`${d}/nope`, `${d}/x`)),
      ];
    },
  },
  {
    name: "cpSync",
    run: (f, d) => {
      f.mkdirSync(`${d}/src/sub`, { recursive: true });
      f.writeFileSync(`${d}/src/a.txt`, "a");
      f.writeFileSync(`${d}/src/skip.log`, "x");
      f.writeFileSync(`${d}/src/sub/b.txt`, "b");
      f.symlinkSync("a.txt", `${d}/src/link`);
      f.cpSync(`${d}/src`, `${d}/out/deep`, {
        recursive: true,
        filter: (s: string) => !s.endsWith(".log"),
      });
      f.cpSync(`${d}/src/a.txt`, `${d}/single.txt`);
      f.writeFileSync(`${d}/existing`, "old");
      f.cpSync(`${d}/src/a.txt`, `${d}/existing`, { force: false });
      return [
        sorted(f.readdirSync(`${d}/out/deep`, { recursive: true }) as string[]),
        f.readlinkSync(`${d}/out/deep/link`),
        f.readFileSync(`${d}/single.txt`, "utf8"),
        f.readFileSync(`${d}/existing`, "utf8"),
        attempt(() =>
          f.cpSync(`${d}/src/a.txt`, `${d}/existing`, { force: false, errorOnExist: true }),
        ),
        attempt(() => f.cpSync(`${d}/src`, `${d}/nonrec`)),
        attempt(() => f.cpSync(`${d}/src`, `${d}/src/sub/inside`, { recursive: true })),
        attempt(() => f.cpSync(`${d}/src/a.txt`, `${d}/src/a.txt`)),
        attempt(() => f.cpSync(`${d}/nope`, `${d}/x`)),
        attempt(() => f.cpSync(`${d}/src`, `${d}/single.txt`, { recursive: true })),
        attempt(() => f.cpSync(`${d}/single.txt`, `${d}/src`)),
        attempt(() =>
          f.cpSync(`${d}/src`, `${d}/p`, {
            filter: () => Promise.resolve(true) as unknown as boolean,
          }),
        ),
      ];
    },
  },
  {
    name: "stat fields",
    run: (f, d) => {
      const file = `${d}/s`;
      f.writeFileSync(file, "12345", { mode: 0o600 });
      f.utimesSync(file, 1000, new Date(5000));
      const st = f.statSync(file);
      const big = f.statSync(file, { bigint: true });
      return [
        st,
        st.mtimeMs,
        st.atimeMs,
        st.mtime.getTime(),
        st.mtime === st.mtime,
        typeof big.size,
        big.mtimeMs,
        big.mtimeNs,
        big.isFile(),
        Object.keys(st).slice(0, 10),
        Object.keys(big).slice(10),
        f.statSync(`${d}/missing`, { throwIfNoEntry: false }),
        f.lstatSync(`${d}/missing`, { throwIfNoEntry: false }),
        f.statSync(d).isDirectory(),
        f.fstatSync(f.openSync(file, "r")).size,
        f.statSync(file).blocks >= 0,
      ];
    },
  },
  {
    name: "stat ENOTDIR with throwIfNoEntry false",
    run: (f, d) => {
      f.writeFileSync(`${d}/s`, "");
      return f.statSync(`${d}/s/x`, { throwIfNoEntry: false });
    },
    node22: {
      error: {
        code: "ENOTDIR",
        syscall: "stat",
        message:
          "ENOTDIR: not a directory, stat '<root>/stat_ENOTDIR_with_throwIfNoEntry_false/s/x'",
        name: "Error",
      },
    },
  },
  {
    name: "times and modes",
    run: (f, d) => {
      const file = `${d}/m`;
      f.writeFileSync(file, "");
      f.chmodSync(file, "644");
      const a = f.statSync(file).mode & 0o777;
      f.chmodSync(file, 0o755);
      const fd = f.openSync(file, "r");
      f.fchmodSync(fd, 0o700);
      f.futimesSync(fd, "2000", 3000);
      f.closeSync(fd);
      const owner = f.statSync(file);
      f.chownSync(file, owner.uid, owner.gid);
      f.lchownSync(file, owner.uid, owner.gid);
      f.lutimesSync(file, 10, 20);
      return [
        a,
        f.statSync(file).mode & 0o777,
        f.statSync(file).mtimeMs,
        attempt(() => f.chownSync(`${d}/nope`, owner.uid, owner.gid)),
        attempt(() => f.fchownSync(999, owner.uid, owner.gid)),
      ];
    },
  },
  {
    name: "access and exists",
    run: (f, d) => {
      f.writeFileSync(`${d}/e`, "");
      return [
        attempt(() => f.accessSync(`${d}/e`)),
        attempt(() => f.accessSync(`${d}/e`, f.constants.R_OK | f.constants.W_OK)),
        attempt(() => f.accessSync(`${d}/e`, f.constants.X_OK)),
        attempt(() => f.accessSync(`${d}/nope`)),
        f.existsSync(`${d}/e`),
        f.existsSync(`${d}/e/`),
        f.existsSync(`${d}/nope`),
        f.existsSync(undefined as unknown as string),
        f.existsSync("a\u0000b"),
      ];
    },
  },
  {
    name: "whole-file reads and writes",
    run: (f, d) => {
      const file = `${d}/w`;
      f.writeFileSync(file, "﻿bom and ünïcode");
      const out: unknown[] = [f.readFileSync(file, "utf8"), f.readFileSync(file).length];
      f.writeFileSync(file, new Uint8Array([104, 105]));
      out.push(f.readFileSync(file, { encoding: "base64" }));
      f.writeFileSync(file, new DataView(new Uint8Array([65, 66, 67]).buffer, 1, 2));
      out.push(f.readFileSync(file, "latin1"));
      f.writeFileSync(file, "6869", "hex");
      out.push(f.readFileSync(file, "utf8"));
      f.writeFileSync(file, "x", { flag: "a" });
      out.push(f.readFileSync(file, { encoding: "utf8", flag: "r+" }));
      out.push(attempt(() => f.writeFileSync(file, "y", { flag: "wx" })));
      out.push(attempt(() => f.readFileSync(d)));
      out.push(attempt(() => f.readFileSync(d, "utf8")));
      out.push(attempt(() => f.writeFileSync(d, "x")));
      out.push(f.readFileSync(`${d}/created`, { flag: "a+", encoding: "utf8" }));
      return out;
    },
  },
  {
    name: "mkdtemp and opendir",
    run: (f, d) => {
      const made = f.mkdtempSync(`${d}/tmp-`);
      f.writeFileSync(`${made}/one`, "");
      f.mkdirSync(`${made}/two`);
      f.writeFileSync(`${made}/two/three`, "");
      const dir = f.opendirSync(made);
      const names: unknown[] = [];
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        names.push([entry.name, entry.isDirectory(), entry.parentPath === made]);
      }
      dir.closeSync();
      const recursive = f.opendirSync(made, { recursive: true });
      const all: string[] = [];
      for (let entry = recursive.readSync(); entry !== null; entry = recursive.readSync()) {
        all.push(`${entry.parentPath.slice(made.length)}/${entry.name}`);
      }
      recursive.closeSync();
      return [
        made.length - `${d}/tmp-`.length,
        sorted(names),
        sorted(all),
        attempt(() => dir.closeSync()),
        attempt(() => f.opendirSync(`${d}/nope`)),
        runError(() => f.opendirSync(`${d}/nope`)),
        attempt(() => f.mkdtempSync(`${d}/nope/tmp-`)),
      ];
    },
  },
  {
    name: "rmdir of a last part dot or dot-dot",
    run: (f, d) => {
      f.mkdirSync(`${d}/t5`);
      f.mkdirSync(`${d}/t6/a`, { recursive: true });
      return [
        attempt(() => f.rmdirSync(`${d}/t5/.`)),
        attempt(() => f.rmdirSync(`${d}/t6/a/..`)),
        attempt(() => f.rmdirSync(`${d}/t5/../t5/.`)),
        f.existsSync(`${d}/t5`),
        f.existsSync(`${d}/t6/a`),
      ];
    },
  },
  {
    name: "mkdir -p through a dangling symbolic link",
    run: (f, d) => {
      f.symlinkSync("m8r", `${d}/m8`);
      f.symlinkSync("m9r", `${d}/m9`);
      return [
        attempt(() => f.mkdirSync(`${d}/m8/a`, { recursive: true })),
        attempt(() => f.mkdirSync(`${d}/m9`, { recursive: true })),
        f.existsSync(`${d}/m8r`),
        f.existsSync(`${d}/m9r`),
        f.readdirSync(d).sort(),
      ];
    },
  },
  {
    name: "rename a file to a name with a trailing slash",
    run: (f, d) => {
      f.writeFileSync(`${d}/f`, "1");
      return [attempt(() => f.renameSync(`${d}/f`, `${d}/nf/`)), f.readdirSync(d)];
    },
    linux: { value: [{ code: "ENOTDIR", syscall: "rename" }, ["f"]] },
  },
];

function runError(fn: () => unknown): unknown {
  try {
    fn();
    return "no error";
  } catch (error) {
    const e = error as Error & { code?: unknown };
    return { code: e.code, message: e.message };
  }
}

describe("fs sync API against node:fs", () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    (_name, scenario) => {
      const { ours, expected } = outcomes(scenario);
      expect(ours).toEqual(expected);
    },
  );
});

/** Calls whose argument errors must match Node's code and message exactly. */
const validationCases: [string, (f: AnyFs) => unknown][] = [
  ["stat number path", (f) => f.statSync(123 as unknown as string)],
  ["stat null byte", (f) => f.statSync("a\u0000b")],
  ["stat http URL", (f) => f.statSync(new URL("http://x/") as unknown as string)],
  ["readFile bad encoding", (f) => f.readFileSync("/x", "bogus" as BufferEncoding)],
  ["readFile bad options", (f) => f.readFileSync("/x", 5 as unknown as BufferEncoding)],
  ["open bad flags", (f) => f.openSync("/x", "bad")],
  ["open bad mode", (f) => f.openSync("/x", "r", "z" as unknown as number)],
  ["fstat float fd", (f) => f.fstatSync(1.5)],
  ["read string fd", (f) => f.readSync("x" as unknown as number, Buffer.alloc(4))],
  ["read negative fd", (f) => f.readSync(-1, Buffer.alloc(4))],
  ["read string buffer", (f) => f.readSync(1, "x" as unknown as Buffer)],
  ["read offset beyond", (f) => f.readSync(1, Buffer.alloc(4), 5, 1, 0)],
  ["read length beyond", (f) => f.readSync(1, Buffer.alloc(4), 0, 5, 0)],
  ["read bad position", (f) => f.readSync(1, Buffer.alloc(4), 0, 1, "x" as unknown as number)],
  ["read position -2", (f) => f.readSync(1, Buffer.alloc(4), 0, 1, -2)],
  ["read empty buffer", (f) => f.readSync(1, Buffer.alloc(0), 0, 1, 0)],
  ["write object", (f) => f.writeSync(1, {} as unknown as string)],
  ["write odd hex", (f) => f.writeSync(1, "abc", null, "hex")],
  ["write length beyond", (f) => f.writeSync(1, Buffer.alloc(2), 0, 3)],
  ["writeFile number", (f) => f.writeFileSync("/x", 123 as unknown as string)],
  ["chmod negative", (f) => f.chmodSync("/x", -1)],
  ["chown string uid", (f) => f.chownSync("/x", "x" as unknown as number, 1)],
  ["utimes object", (f) => f.utimesSync("/x", {} as unknown as number, 1)],
  ["access mode 8", (f) => f.accessSync("/x", 8)],
  ["access string mode", (f) => f.accessSync("/x", "x" as unknown as number)],
  ["copyFile mode 8", (f) => f.copyFileSync("/x", "/y", 8)],
  ["truncate string len", (f) => f.truncateSync("/x", "x" as unknown as number)],
  ["mkdir bad mode", (f) => f.mkdirSync("/m", "x" as unknown as number)],
  ["mkdir bad recursive", (f) => f.mkdirSync("/m", { recursive: "x" as unknown as boolean })],
  ["rm bad force", (f) => f.rmSync("/a", { force: "x" as unknown as boolean })],
  ["rm string options", (f) => f.rmSync("/a", "x" as unknown as object)],
  ["rm negative retries", (f) => f.rmSync("/a", { recursive: true, maxRetries: -1 })],
  ["readv string", (f) => f.readvSync(1, "x" as unknown as Buffer[])],
  ["symlink bad type", (f) => f.symlinkSync("a", "/q", "bad" as "file")],
  ["cp incompatible", (f) => f.cpSync("/a", "/b", { dereference: true, verbatimSymlinks: true })],
  ["createReadStream start > end", (f) => f.createReadStream("/g", { start: 5, end: 2 })],
  ["createReadStream negative start", (f) => f.createReadStream("/g", { start: -1 })],
  ["createReadStream null path", (f) => f.createReadStream(null as unknown as string)],
  ["read missing callback", (f) => (f.read as unknown as (fd: number) => void)(1)],
  ["stat missing callback", (f) => (f.stat as unknown as (p: string) => void)("/")],
  ["exists missing callback", (f) => (f.exists as unknown as (p: string) => void)("/")],
  ["watchFile missing listener", (f) => (f.watchFile as unknown as (p: string) => void)("/nope")],
  ["readdir bad recursive", (f) => f.readdirSync("/", { recursive: 1 as unknown as boolean })],
  ["opendir bad bufferSize", (f) => f.opendirSync("/", { bufferSize: 0 })],
];

/** Node 22's errors where the host's newer Node words or checks them differently. */
const NODE_22_ERRORS: Record<string, unknown> = {
  // Node 22 swaps the name and value in this message (fixed in later Node).
  "readFile bad encoding": {
    code: "ERR_INVALID_ARG_VALUE",
    message: "The argument 'bogus' is invalid encoding. Received 'encoding'",
  },
  "symlink bad type": {
    code: "ERR_FS_INVALID_SYMLINK_TYPE",
    message: 'Symlink type must be one of "dir", "file", or "junction". Received "bad"',
  },
};

describe("argument validation matches node:fs", () => {
  it.each(validationCases)("%s", (name, call) => {
    const ours = runError(() => call(fs as unknown as AnyFs));
    const node = NODE_22_ERRORS[name] ?? runError(() => call(sides.node.fs));
    expect(ours).toEqual(node);
  });
});

describe("webnode specifics", () => {
  it("resolves relative paths against the runtime's cwd and reports them as given", () => {
    fs.writeFileSync("rel.txt", "r");
    expect(sides.runtime.vfs.readFile("/work/rel.txt")).toEqual(new TextEncoder().encode("r"));
    expect(fs.readFileSync("./rel.txt", "utf8")).toBe("r");
    expect(() => fs.readFileSync("nope.txt")).toThrow(
      "ENOENT: no such file or directory, open 'nope.txt'",
    );
    expect(() => fs.statSync("rel.txt/")).toThrow(
      expect.objectContaining({ code: "ENOTDIR", path: "rel.txt/" }),
    );
    expect(fs.mkdirSync("p/q/r", { recursive: true })).toBe("p");
    expect(fs.mkdtempSync("t-")).toMatch(/^t-[A-Za-z0-9]{6}$/);
    expect(fs.realpathSync("p/q/..")).toBe("/work/p");
    expect(() => fs.realpathSync("nope/x")).toThrow(
      "ENOENT: no such file or directory, lstat '/work/nope'",
    );
  });

  it("accepts Buffer and file: URL paths", () => {
    fs.writeFileSync(Buffer.from("/work/b.txt"), "b");
    expect(fs.readFileSync(new URL("file:///work/b.txt"), "utf8")).toBe("b");
  });

  it("reads a file with one backend call and wraps it without copying", () => {
    fs.writeFileSync("/work/one", "abc");
    const calls: string[] = [];
    const original = sides.runtime.fs;
    const counting = new Proxy(original, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            calls.push(String(key));
            return (value as (...a: unknown[]) => unknown)(...args);
          };
        }
        return value;
      },
    });
    Object.defineProperty(sides.runtime, "fs", { value: counting, configurable: true });
    try {
      const buffer = fs.readFileSync("/work/one") as unknown as Buffer;
      expect(buffer.toString()).toBe("abc");
      expect(fs.readFileSync("/work/one", "utf8")).toBe("abc");
      fs.writeFileSync("/work/one", "xyz");
      expect(fs.existsSync("/work/one")).toBe(true);
      fs.readdirSync("/work", { withFileTypes: true });
      expect(calls).toEqual(["readFile", "readFile", "writeFile", "exists", "readdir"]);
    } finally {
      Object.defineProperty(sides.runtime, "fs", { value: original, configurable: true });
    }
  });

  it("writes and reads fds 1, 2 and 0 through the backend", () => {
    fs.writeSync(1, "out\n");
    fs.writeFileSync(2, "err\n");
    expect(sides.runtime.stdout()).toBe("out\n");
    expect(sides.runtime.stderr()).toBe("err\n");
    sides.runtime.feedStdin("in");
    sides.runtime.feedStdin(null);
    expect(fs.readFileSync(0, "utf8")).toBe("in");
  });

  it("exposes Node 22's module shape", () => {
    expect(fs.constants.O_CREAT).toBe(0o100);
    expect(fs.constants.O_DIRECTORY).toBe(0o200000);
    expect(fs.F_OK).toBe(0);
    expect(typeof fs.realpathSync.native).toBe("function");
    expect(typeof fs.realpath.native).toBe("function");
    expect(fs.FileReadStream).toBe(fs.ReadStream);
    expect(() => fs.globSync()).toThrow(
      expect.objectContaining({ code: "ERR_METHOD_NOT_IMPLEMENTED" }),
    );
    const patched = fs as unknown as { ReadStream: unknown };
    const original = patched.ReadStream;
    patched.ReadStream = 1;
    expect(patched.ReadStream).toBe(1);
    patched.ReadStream = original;
    expect(fs.statfsSync("/work").bsize).toBe(4096);
  });

  it("rmSync gives ERR_FS_EISDIR as a SystemError", () => {
    fs.mkdirSync("/work/d");
    let error: (Error & Record<string, unknown>) | undefined;
    try {
      fs.rmSync("/work/d");
    } catch (caught) {
      error = caught as Error & Record<string, unknown>;
    }
    expect(error?.name).toBe("SystemError");
    expect(error?.code).toBe("ERR_FS_EISDIR");
    expect(error?.message).toBe("Path is a directory: rm returned EISDIR (is a directory) /work/d");
    expect(String(error)).toBe(
      "SystemError [ERR_FS_EISDIR]: Path is a directory: rm returned EISDIR (is a directory) /work/d",
    );
  });
});

// @vitest-environment node
// Permission errors of the `fs` API, scenario by scenario against the host's
// real `node:fs` (the host is not root, so its permissions are enforced):
// every refusal's code, syscall and message must match. Where Linux and the
// macOS host differ, the scenario states the Linux (and so webnode) outcome.
// Each scenario gives every mode back before it ends, so its directory can be
// removed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attempt,
  makeSides,
  runAsync,
  runSync,
  scenarioDirs,
  type AnyFs,
  type Sides,
} from "./compare.testkit";

interface Scenario {
  name: string;
  run: (fs: AnyFs, dir: string) => unknown;
  /** The Linux outcome, checked instead of the host's when the host is not Linux. */
  linux?: unknown;
}

let sides: Sides;

beforeEach(() => {
  sides = makeSides();
});

afterEach(() => {
  sides.cleanup();
});

/** Runs `run` with `modes` set (path below `d` → mode), giving each back after. */
function withModes<T>(f: AnyFs, d: string, modes: [string, number][], run: () => T): T {
  for (const [path, mode] of modes) {
    f.chmodSync(`${d}/${path}`, mode);
  }
  try {
    return run();
  } finally {
    for (const [path] of [...modes].reverse()) {
      try {
        f.chmodSync(`${d}/${path}`, 0o755);
      } catch {
        // Removed by the scenario.
      }
    }
  }
}

/** `attempt` with the error's message too, the sandbox root replaced. */
function tried(d: string, fn: () => unknown): unknown {
  const root = d.slice(0, d.lastIndexOf("/"));
  try {
    const value = fn();
    return value === undefined ? "ok" : value;
  } catch (error) {
    const e = error as Error & { code?: unknown; syscall?: unknown; errno?: unknown };
    return {
      code: e.code,
      syscall: e.syscall,
      errno: e.errno,
      message: String(e.message).split(root).join("<root>"),
    };
  }
}

const scenarios: Scenario[] = [
  {
    name: "a file with no permissions",
    run: (f, d) => {
      f.writeFileSync(`${d}/f`, "data");
      return withModes(f, d, [["f", 0]], () => [
        tried(d, () => f.readFileSync(`${d}/f`, "utf8")),
        tried(d, () => f.writeFileSync(`${d}/f`, "x")),
        tried(d, () => f.appendFileSync(`${d}/f`, "x")),
        tried(d, () => f.openSync(`${d}/f`, "r")),
        tried(d, () => f.accessSync(`${d}/f`)),
        tried(d, () => f.accessSync(`${d}/f`, f.constants.R_OK)),
        tried(d, () => f.statSync(`${d}/f`).mode & 0o777),
        // Its owner may still change its mode and times.
        tried(d, () => f.chmodSync(`${d}/f`, 0)),
        tried(d, () => f.utimesSync(`${d}/f`, 1, 1)),
      ]);
    },
  },
  {
    name: "a read-only file",
    run: (f, d) => {
      f.writeFileSync(`${d}/f`, "data");
      return withModes(f, d, [["f", 0o444]], () => [
        tried(d, () => f.writeFileSync(`${d}/f`, "x")),
        tried(d, () => f.appendFileSync(`${d}/f`, "x")),
        tried(d, () => f.truncateSync(`${d}/f`, 0)),
        tried(d, () => f.openSync(`${d}/f`, "r+")),
        tried(d, () => f.openSync(`${d}/f`, f.constants.O_RDONLY | f.constants.O_TRUNC)),
        tried(d, () =>
          f.closeSync(f.openSync(`${d}/f`, f.constants.O_RDONLY | f.constants.O_CREAT)),
        ),
        tried(d, () => f.openSync(`${d}/f`, "wx")),
        tried(d, () => f.accessSync(`${d}/f`, f.constants.W_OK)),
        tried(d, () => f.accessSync(`${d}/f`, f.constants.X_OK)),
        tried(d, () => f.readFileSync(`${d}/f`, "utf8")),
        tried(d, () => f.copyFileSync(`${d}/f`, `${d}/copy`)),
        tried(d, () => f.statSync(`${d}/copy`).mode & 0o777),
        tried(d, () => f.copyFileSync(`${d}/copy`, `${d}/f`)),
        tried(d, () => f.chmodSync(`${d}/copy`, 0o644)),
        tried(d, () => f.readFileSync(`${d}/f`, "utf8")),
      ]);
    },
  },
  {
    // chown(2) for a user who is not root: only the owner and group the file
    // has already.
    name: "a change of owner or group",
    run: (f, d) => {
      f.writeFileSync(`${d}/f`, "data");
      f.symlinkSync("f", `${d}/link`);
      const { uid, gid } = f.statSync(`${d}/f`);
      const fd = f.openSync(`${d}/f`, "r+");
      try {
        return [
          tried(d, () => f.chownSync(`${d}/f`, uid, gid)),
          tried(d, () => f.chownSync(`${d}/f`, -1, -1)),
          tried(d, () => f.chownSync(`${d}/f`, 12345, gid)),
          tried(d, () => f.chownSync(`${d}/f`, uid, 12345)),
          tried(d, () => f.chownSync(`${d}/link`, 12345, -1)),
          tried(d, () => f.lchownSync(`${d}/link`, 12345, 12345)),
          tried(d, () => f.lchownSync(`${d}/link`, -1, -1)),
          tried(d, () => f.fchownSync(fd, 12345, 12345)),
          tried(d, () => f.fchownSync(fd, uid, gid)),
          tried(d, () => f.chownSync(`${d}/missing`, uid, gid)),
        ];
      } finally {
        f.closeSync(fd);
      }
    },
  },
  {
    name: "a write-only file",
    run: (f, d) => {
      f.writeFileSync(`${d}/f`, "data");
      return withModes(f, d, [["f", 0o222]], () => [
        tried(d, () => f.readFileSync(`${d}/f`, "utf8")),
        tried(d, () => f.writeFileSync(`${d}/f`, "new")),
        tried(d, () => f.truncateSync(`${d}/f`, 0)),
        tried(d, () => f.copyFileSync(`${d}/f`, `${d}/copy`)),
        tried(d, () => f.existsSync(`${d}/copy`)),
      ]);
    },
  },
  {
    name: "a read-only directory",
    run: (f, d) => {
      f.mkdirSync(`${d}/ro/sub`, { recursive: true });
      f.writeFileSync(`${d}/ro/in`, "in");
      f.writeFileSync(`${d}/out`, "out");
      return withModes(f, d, [["ro", 0o555]], () => [
        tried(d, () => f.writeFileSync(`${d}/ro/new`, "x")),
        tried(d, () => f.writeFileSync(`${d}/ro/in`, "changed")),
        tried(d, () => f.mkdirSync(`${d}/ro/m`)),
        tried(d, () => f.mkdirSync(`${d}/ro/sub`)),
        tried(d, () => f.mkdirSync(`${d}/ro/sub`, { recursive: true })),
        tried(d, () => f.mkdirSync(`${d}/ro/m/n`, { recursive: true })),
        tried(d, () => f.unlinkSync(`${d}/ro/in`)),
        tried(d, () => f.unlinkSync(`${d}/ro/nope`)),
        tried(d, () => f.rmdirSync(`${d}/ro/sub`)),
        tried(d, () => f.renameSync(`${d}/ro/in`, `${d}/ro/in2`)),
        tried(d, () => f.renameSync(`${d}/ro/in`, `${d}/moved`)),
        tried(d, () => f.renameSync(`${d}/out`, `${d}/ro/out`)),
        tried(d, () => f.symlinkSync("in", `${d}/ro/l`)),
        tried(d, () => f.linkSync(`${d}/out`, `${d}/ro/hard`)),
        tried(d, () => f.openSync(`${d}/ro/n2`, "wx")),
        tried(d, () => f.closeSync(f.openSync(`${d}/ro/in`, "w"))),
        tried(d, () => f.mkdtempSync(`${d}/ro/t-`)),
        tried(d, () => f.copyFileSync(`${d}/out`, `${d}/ro/c`)),
        tried(d, () => f.rmSync(`${d}/ro/in`)),
        tried(d, () => f.rmSync(`${d}/ro/sub`, { recursive: true, force: true })),
        tried(d, () => f.rmSync(`${d}/ro/missing`, { force: true })),
        tried(d, () => f.accessSync(`${d}/ro`, f.constants.W_OK)),
        tried(d, () => f.readdirSync(`${d}/ro`).sort()),
      ]);
    },
  },
  {
    name: "a directory that cannot be searched",
    run: (f, d) => {
      f.mkdirSync(`${d}/nx/sub`, { recursive: true });
      f.writeFileSync(`${d}/nx/in`, "in");
      f.symlinkSync("nx/in", `${d}/link`);
      return withModes(f, d, [["nx", 0o644]], () => [
        tried(d, () => f.statSync(`${d}/nx`).mode & 0o777),
        tried(d, () => f.statSync(`${d}/nx/`).mode & 0o777),
        tried(d, () => f.statSync(`${d}/nx/in`)),
        tried(d, () => f.lstatSync(`${d}/nx/in`)),
        tried(d, () => f.statSync(`${d}/nx/missing`)),
        tried(d, () => f.statSync(`${d}/nx/.`)),
        tried(d, () => f.statSync(`${d}/nx/..`)),
        tried(d, () => f.statSync(`${d}/link`)),
        tried(d, () => f.lstatSync(`${d}/link`).isSymbolicLink()),
        tried(d, () => f.existsSync(`${d}/nx/in`)),
        tried(d, () => f.existsSync(`${d}/link`)),
        tried(d, () => f.readdirSync(`${d}/nx`).sort()),
        tried(d, () => f.readFileSync(`${d}/nx/in`, "utf8")),
        tried(d, () => f.accessSync(`${d}/nx`, f.constants.X_OK)),
        tried(d, () => f.accessSync(`${d}/nx`, f.constants.R_OK)),
        tried(d, () => f.chmodSync(`${d}/nx/in`, 0o600)),
        tried(d, () => f.utimesSync(`${d}/nx/in`, 1, 1)),
        tried(d, () => f.readlinkSync(`${d}/nx/in`)),
        tried(d, () => f.realpathSync(`${d}/nx/in`)),
        tried(d, () => f.realpathSync.native(`${d}/nx/in`)),
        tried(d, () => f.closeSync(f.openSync(`${d}/nx`, "r"))),
        tried(d, () => f.writeFileSync(`${d}/nx/new`, "x")),
        tried(d, () => f.mkdirSync(`${d}/nx/a/b`, { recursive: true })),
      ]);
    },
  },
  {
    name: "a directory that cannot be read",
    run: (f, d) => {
      f.mkdirSync(`${d}/nr`);
      f.writeFileSync(`${d}/nr/in`, "in");
      return withModes(f, d, [["nr", 0o311]], () => [
        tried(d, () => f.readdirSync(`${d}/nr`)),
        tried(d, () => f.opendirSync(`${d}/nr`)),
        tried(d, () => f.statSync(`${d}/nr/in`).size),
        tried(d, () => f.readFileSync(`${d}/nr/in`, "utf8")),
        tried(d, () => f.readFileSync(`${d}/nr`)),
        tried(d, () => f.closeSync(f.openSync(`${d}/nr`, "r"))),
        tried(d, () => f.writeFileSync(`${d}/nr/new`, "x")),
        tried(d, () => f.rmSync(`${d}/nr`, { recursive: true })),
        tried(d, () => f.existsSync(`${d}/nr/new`)),
      ]);
    },
  },
  {
    name: "a directory below the start of a recursive readdir that cannot be read",
    run: (f, d) => {
      f.mkdirSync(`${d}/t/a/nr/in`, { recursive: true });
      f.writeFileSync(`${d}/t/a/f`, "");
      return withModes(f, d, [["t/a/nr", 0o311]], () =>
        [`${d}/t`, `${d}/t/`, `${d}/t//`, `${d}/t/a/..`, `${d}/./t`].flatMap((start) => [
          tried(d, () => f.readdirSync(start, { recursive: true })),
          tried(d, () => f.readdirSync(start, { recursive: true, withFileTypes: true })),
        ]),
      );
    },
  },
  {
    name: "an empty directory with no permissions",
    run: (f, d) => {
      f.mkdirSync(`${d}/z`);
      f.mkdirSync(`${d}/z2`);
      return withModes(
        f,
        d,
        [
          ["z", 0],
          ["z2", 0],
        ],
        () => [
          tried(d, () => f.statSync(`${d}/z`).mode & 0o777),
          tried(d, () => f.rmSync(`${d}/z2`, { recursive: true })),
          tried(d, () => f.rmdirSync(`${d}/z`)),
          tried(d, () => f.existsSync(`${d}/z`)),
        ],
      );
    },
  },
  {
    name: "a directory moved to another parent",
    run: (f, d) => {
      f.mkdirSync(`${d}/a/mv`, { recursive: true });
      f.mkdirSync(`${d}/b`);
      return withModes(f, d, [["a/mv", 0o555]], () => [
        tried(d, () => f.renameSync(`${d}/a/mv`, `${d}/b/mv`)),
        tried(d, () => f.renameSync(`${d}/a/mv`, `${d}/a/renamed`)),
        tried(d, () => f.renameSync(`${d}/a/renamed`, `${d}/a/mv`)),
      ]);
    },
  },
  {
    name: "cpSync of a read-only tree",
    run: (f, d) => {
      f.mkdirSync(`${d}/src/sub`, { recursive: true });
      f.writeFileSync(`${d}/src/sub/f`, "f");
      return withModes(
        f,
        d,
        [
          ["src/sub/f", 0o444],
          ["src/sub", 0o555],
          ["src", 0o555],
        ],
        () => {
          const copied = tried(d, () => f.cpSync(`${d}/src`, `${d}/out`, { recursive: true }));
          const modes = ["out", "out/sub", "out/sub/f"].map(
            (path) => f.statSync(`${d}/${path}`).mode & 0o777,
          );
          for (const path of ["out/sub", "out"]) {
            f.chmodSync(`${d}/${path}`, 0o755);
          }
          return [copied, modes];
        },
      );
    },
  },
  {
    name: "unlinking a directory in a read-only directory",
    run: (f, d) => {
      f.mkdirSync(`${d}/ro/sub`, { recursive: true });
      return withModes(f, d, [["ro", 0o555]], () => tried(d, () => f.unlinkSync(`${d}/ro/sub`)));
    },
    // macOS checks the kind first (EPERM); Linux the directory's permission.
    linux: {
      value: {
        code: "EACCES",
        syscall: "unlink",
        errno: -13,
        message:
          "EACCES: permission denied, unlink '<root>/unlinking_a_directory_in_a_read_only_directory/ro/sub'",
      },
    },
  },
  {
    name: "rmdir of a file in a read-only directory",
    run: (f, d) => {
      f.mkdirSync(`${d}/ro`);
      f.writeFileSync(`${d}/ro/f`, "f");
      return withModes(f, d, [["ro", 0o555]], () => tried(d, () => f.rmdirSync(`${d}/ro/f`)));
    },
    linux: {
      value: {
        code: "EACCES",
        syscall: "rmdir",
        errno: -13,
        message:
          "EACCES: permission denied, rmdir '<root>/rmdir_of_a_file_in_a_read_only_directory/ro/f'",
      },
    },
  },
  {
    name: "rmSync of a tree it cannot empty",
    run: (f, d) => {
      f.mkdirSync(`${d}/t/ro`, { recursive: true });
      f.writeFileSync(`${d}/t/ro/f`, "f");
      f.mkdirSync(`${d}/nx`);
      f.writeFileSync(`${d}/nx/f`, "f");
      return withModes(
        f,
        d,
        [
          ["t/ro", 0o555],
          ["nx", 0o644],
        ],
        () => [
          tried(d, () => f.rmSync(`${d}/t`, { recursive: true, force: true })),
          tried(d, () => f.rmSync(`${d}/nx`, { recursive: true })),
          tried(d, () => f.existsSync(`${d}/t/ro`)),
        ],
      );
    },
    // libc++'s remove_all reports what it could not empty last (ENOTEMPTY);
    // libstdc++'s, the refusal it met (EACCES), naming the path given.
    linux: {
      value: [
        {
          code: "EACCES",
          syscall: "rm",
          errno: 13,
          message: "EACCES, Permission denied: '<root>/rmSync_of_a_tree_it_cannot_empty/t'",
        },
        {
          code: "EACCES",
          syscall: "rm",
          errno: 13,
          message: "EACCES, Permission denied: '<root>/rmSync_of_a_tree_it_cannot_empty/nx'",
        },
        true,
      ],
    },
  },
];

describe("permissions against node:fs", () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "%s",
    (_name, scenario) => {
      const dirs = scenarioDirs(sides, scenario.name.replace(/\W+/g, "_"));
      const ours = runSync(sides.ours, dirs.ours, scenario.run);
      const expected =
        scenario.linux !== undefined && process.platform !== "linux"
          ? scenario.linux
          : runSync(sides.node, dirs.node, scenario.run);
      expect(ours).toEqual(expected);
    },
  );

  it("removes what it can asynchronously, as Node's rimraf does, and names the refusal", async () => {
    const run = async (f: AnyFs, d: string) => {
      f.mkdirSync(`${d}/t/ro`, { recursive: true });
      f.writeFileSync(`${d}/t/ro/f`, "f");
      f.writeFileSync(`${d}/t/ok`, "ok");
      f.writeFileSync(`${d}/file`, "x");
      f.chmodSync(`${d}/t/ro`, 0o555);
      try {
        const steps: unknown[] = [];
        for (const action of [
          () => f.promises.rm(`${d}/t`, { recursive: true }),
          () => f.promises.rm(`${d}/t/ro/f`),
          () => new Promise((resolve) => f.rm(`${d}/t/ro/f`, (error) => resolve(error))),
        ]) {
          try {
            const result = await action();
            steps.push(result ?? "ok");
          } catch (error) {
            steps.push(error);
          }
        }
        return [steps, f.readdirSync(`${d}/t`), f.readdirSync(`${d}/t/ro`)];
      } finally {
        f.chmodSync(`${d}/t/ro`, 0o755);
      }
    };
    const dirs = scenarioDirs(sides, "async_rm");
    const ours = await runAsync(sides.ours, dirs.ours, run);
    const expected = await runAsync(sides.node, dirs.node, run);
    expect(ours).toEqual(expected);
    expect(JSON.stringify(ours)).toContain("unlink");
  });

  it("asks what is there before an asynchronous removal, whatever the options", async () => {
    // fs.rm and fs.promises.rm lstat the path first, and report whatever
    // that fails with except a missing path under `force`; rmSync asks only
    // when it has to refuse a directory, or a missing path.
    const targets: [string, { recursive?: boolean; force?: boolean }][] = [
      ["nx/none", { recursive: true, force: true }],
      ["nx/none", { force: true }],
      ["nx/in", { recursive: true, force: true }],
      ["nx/in", {}],
      ["f/below", { recursive: true, force: true }],
      ["missing", { recursive: true, force: true }],
      ["missing", { recursive: true }],
    ];
    const run = async (f: AnyFs, d: string) => {
      f.mkdirSync(`${d}/nx`);
      f.writeFileSync(`${d}/nx/in`, "x");
      f.writeFileSync(`${d}/f`, "x");
      f.chmodSync(`${d}/nx`, 0o644);
      const steps: unknown[] = [];
      try {
        for (const [name, options] of targets) {
          const path = `${d}/${name}`;
          steps.push([
            "promises",
            name,
            options,
            await f.promises.rm(path, options).then(
              () => "ok",
              (error: unknown) => error,
            ),
          ]);
          steps.push([
            "callback",
            name,
            options,
            await new Promise((resolve) => f.rm(path, options, (error) => resolve(error ?? "ok"))),
          ]);
        }
      } finally {
        f.chmodSync(`${d}/nx`, 0o755);
      }
      return steps;
    };
    const dirs = scenarioDirs(sides, "async_rm_lstat");
    const ours = await runAsync(sides.ours, dirs.ours, run);
    const expected = await runAsync(sides.node, dirs.node, run);
    expect(ours).toEqual(expected);
    expect(JSON.stringify(ours)).toContain(
      "EACCES: permission denied, lstat '<root>/async_rm_lstat/nx/none'",
    );
  });

  it("makes a tree with mkdir -p as Node does, in each form", async () => {
    // Node's MKDirpSync and MKDirpAsync make one directory per step, on the
    // path as the caller spelled it. The sync form names the whole path when
    // it fails; the callback and promise forms name the step that failed.
    // Each form returns the first directory it made in the caller's spelling
    // ('q/' for 'q/', 'x/' for 'x//y'). Each form works in a tree of its own.
    const cases: [string, number?][] = [
      ["ro/a/b"],
      ["ro/a"],
      ["ro/a/b/"],
      ["ro/x/../y"],
      ["p/a/b/c", 0o555],
      ["f/a/b"],
      ["f"],
      ["l"],
      ["l/a"],
      ["p/q/r/"],
      ["p//s//t"],
      ["p/q"],
      ["p/v/q/"],
      ["p/v/r/s/"],
      ["p/v//x//y"],
      ["w//"],
      ["p/v/t//u"],
      ["p/v"],
      // Several directories to make below one that is there, and the same
      // path once it is; then spellings whose steps are not plain names.
      ["p/n1/n2/n3/n4"],
      ["p/n1/n2/n3/n4"],
      ["p/n1/n2/n3/n4/"],
      ["p/d1/./d2/d3"],
      ["p/g1/../g2/g3"],
      ["p/j1//j2/j3"],
      ["p/h1/h2/h3/"],
      ["p/k1/k2/."],
      ["p/k3/k4/.."],
      ["f/x/y/z"],
      ["l/x/y/z"],
      ["ro/a/b/c/d"],
      ["p/q1/q2/q3", 0o555],
    ];
    type Options = { recursive: true; mode?: number };
    const forms: [string, (f: AnyFs, path: string, options: Options) => Promise<unknown>][] = [
      [
        "callback",
        (f, path, options) =>
          new Promise((resolve) =>
            f.mkdir(path, options, (error, first) => resolve(error ?? first ?? "ok")),
          ),
      ],
      [
        "promises",
        (f, path, options) =>
          f.promises.mkdir(path, options).then(
            (first) => first ?? "ok",
            (error: unknown) => error,
          ),
      ],
      [
        "sync",
        async (f, path, options) => {
          try {
            return f.mkdirSync(path, options) ?? "ok";
          } catch (error) {
            return error;
          }
        },
      ],
    ];
    const run = async (f: AnyFs, d: string) => {
      const steps: unknown[] = [];
      for (const [form, make] of forms) {
        const t = `${d}/${form}`;
        f.mkdirSync(`${t}/ro`, { recursive: true });
        f.mkdirSync(`${t}/p`);
        f.writeFileSync(`${t}/f`, "");
        f.symlinkSync("missing", `${t}/l`);
        f.chmodSync(`${t}/ro`, 0o555);
        try {
          for (const [path, mode] of cases) {
            const options: Options =
              mode === undefined ? { recursive: true } : { recursive: true, mode };
            steps.push([form, path, await make(f, `${t}/${path}`, options)]);
          }
        } finally {
          f.chmodSync(`${t}/ro`, 0o755);
          f.chmodSync(`${t}/p/a`, 0o755);
        }
      }
      return steps;
    };
    const dirs = scenarioDirs(sides, "mkdirp");
    const ours = await runAsync(sides.ours, dirs.ours, run);
    const expected = await runAsync(sides.node, dirs.node, run);
    expect(ours).toEqual(expected);
    const text = JSON.stringify(ours);
    expect(text).toContain("mkdir '<root>/mkdirp/promises/ro/a'");
    expect(text).toContain("mkdir '<root>/mkdirp/sync/ro/a/b/'");
    expect(text).toContain('"<root>/mkdirp/sync/p/v//x/"');
  });

  it("names the failed step as the caller spelled the path", async () => {
    // Real node v26 in a directory holding w/ro (mode 555) and w/v:
    // 'w/ro/a/b/' fails at 'w/ro/a', 'w/ro/x/../y' at 'w/ro/x'; 'w/v/q/'
    // returns 'w/v/q/' and 'w/v//x//y' returns 'w/v//x/'.
    const f = sides.ours.fs;
    f.mkdirSync("/work/w/ro", { recursive: true });
    f.mkdirSync("/work/w/v");
    f.chmodSync("/work/w/ro", 0o555);
    const results: unknown[] = [];
    for (const path of ["w/ro/a/b/", "w/ro/x/../y", "w/v/q/", "w/v//x//y"]) {
      results.push(
        await f.promises.mkdir(path, { recursive: true }).then(
          (first) => first,
          (error: Error) => error.message,
        ),
      );
    }
    expect(results).toEqual([
      "EACCES: permission denied, mkdir 'w/ro/a'",
      "EACCES: permission denied, mkdir 'w/ro/x'",
      "w/v/q/",
      "w/v//x/",
    ]);
  });

  it("names the directory opendir could not open, except in the sync form", async () => {
    // Node's opendirSync reports no path; fs.opendir and fs.promises.opendir
    // name the directory as the caller spelled it.
    type Failure = Error & { code?: unknown; syscall?: unknown; path?: unknown };
    const shape = (root: string, error: Failure) => ({
      code: error.code,
      syscall: error.syscall,
      path: typeof error.path === "string" ? error.path.split(root).join("<root>") : error.path,
      message: error.message.split(root).join("<root>"),
    });
    const forms: [string, (f: AnyFs, path: string) => Promise<unknown>][] = [
      [
        "sync",
        async (f, path) => {
          try {
            f.opendirSync(path).closeSync();
            return "ok";
          } catch (error) {
            return error;
          }
        },
      ],
      [
        "callback",
        (f, path) =>
          new Promise((resolve) =>
            f.opendir(path, (error, dir) => {
              dir?.closeSync();
              resolve(error ?? "ok");
            }),
          ),
      ],
      [
        "promises",
        (f, path) =>
          f.promises.opendir(path).then(
            (dir) => dir.close().then(() => "ok"),
            (error: unknown) => error,
          ),
      ],
    ];
    const run = async (f: AnyFs, d: string) => {
      const root = d.slice(0, d.lastIndexOf("/"));
      f.mkdirSync(`${d}/nr`);
      f.mkdirSync(`${d}/open`);
      f.writeFileSync(`${d}/file`, "");
      f.chmodSync(`${d}/nr`, 0o311);
      const steps: unknown[] = [];
      try {
        for (const name of ["nr", "missing", "file", "file/below", "open"]) {
          for (const [form, open] of forms) {
            const result = await open(f, `${d}/${name}`);
            steps.push([form, name, result instanceof Error ? shape(root, result) : result]);
          }
        }
      } finally {
        f.chmodSync(`${d}/nr`, 0o755);
      }
      return steps;
    };
    const dirs = scenarioDirs(sides, "opendir");
    const ours = await runAsync(sides.ours, dirs.ours, run);
    const expected = await runAsync(sides.node, dirs.node, run);
    expect(ours).toEqual(expected);
    const text = JSON.stringify(ours);
    expect(text).toContain("EACCES: permission denied, opendir '<root>/opendir/nr'");
    expect(text).toContain('"message":"EACCES: permission denied, opendir"');

    // The caller's own spelling of a relative path, not the absolute one.
    const relative = await sides.ours.fs.promises
      .opendir("opendir/missing")
      .catch((error) => error);
    expect(shape("/work", relative)).toEqual({
      code: "ENOENT",
      syscall: "opendir",
      path: "opendir/missing",
      message: "ENOENT: no such file or directory, opendir 'opendir/missing'",
    });
  });

  it("checks nothing a page writes through the kernel's own view", () => {
    const { ours, runtime } = sides;
    ours.fs.mkdirSync("/work/locked");
    ours.fs.writeFileSync("/work/locked/f", "1");
    ours.fs.chmodSync("/work/locked/f", 0);
    ours.fs.chmodSync("/work/locked", 0o555);
    expect(attempt(() => ours.fs.writeFileSync("/work/locked/f", "2"))).toEqual({
      code: "EACCES",
      syscall: "open",
    });
    runtime.vfs.privileged.writeFile(
      "/work/locked/f",
      new TextEncoder().encode("2"),
      0o1101,
      0o644,
    );
    expect(new TextDecoder().decode(runtime.vfs.privileged.readFile("/work/locked/f"))).toBe("2");
  });
});

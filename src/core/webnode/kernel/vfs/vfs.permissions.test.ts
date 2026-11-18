// @vitest-environment node
// The permission rules, on both filesystems (the TypeScript one and sharedfs,
// whose Rust tests in crate/src/fs/permission_tests.rs are the same cases):
// what Linux checks for a user who is not root, who owns every file but those
// given to root, so the owner's bits decide, or the others' on root's.
// `privileged` (the page's view) checks nothing.
import { describe, expect, it } from "vitest";
import type { SystemError } from "../../errors";
import { createSharedFilesystem } from "../../sharedfs/boot";
import {
  COPYFILE_EXCL,
  F_OK,
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  R_OK,
  W_OK,
  X_OK,
  type PermissionedVfs,
} from "./types";
import { Vfs } from "./vfs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WRITE = O_WRONLY | O_CREAT | O_TRUNC;

type TestFs = PermissionedVfs & { totals(): { inodes: number; bytes: number } };

const IMPLEMENTATIONS: [name: string, create: () => TestFs][] = [
  ["Vfs", () => new Vfs()],
  [
    "SharedFs",
    () => {
      const shared = createSharedFilesystem();
      if (shared === null) {
        throw new Error("this engine cannot make the shared filesystem");
      }
      return shared.fs;
    },
  ],
];

/** The system error `action` throws, reduced to the fields a test compares. */
function failure(action: () => unknown): Partial<SystemError> {
  try {
    action();
  } catch (error) {
    const { code, syscall, path, dest, message } = error as SystemError;
    return { code, syscall, path, dest, message };
  }
  throw new Error("expected the call to throw");
}

/** `failure`, for an EACCES naming `syscall` and `path` (and `dest`). */
function refused(syscall: string, path: string, dest?: string): Partial<SystemError> {
  return dest === undefined
    ? { code: "EACCES", syscall, path }
    : { code: "EACCES", syscall, path, dest };
}

describe.each(IMPLEMENTATIONS)("%s", (_name, create) => {
  const put = (fs: PermissionedVfs | TestFs["privileged"], path: string, text: string) =>
    fs.writeFile(path, encoder.encode(text), WRITE, 0o644);
  const read = (fs: TestFs, path: string) => decoder.decode(fs.readFile(path));
  const mode = (fs: TestFs, path: string) => fs.stat(path, false).mode & 0o7777;
  /** Everything below `path`, relative to it, a directory with a trailing `/`. */
  const listing = (fs: TestFs, path: string): string[] =>
    fs.privileged
      .readdir(path)
      .flatMap((entry) =>
        entry.type === "dir"
          ? [
              `${entry.name}/`,
              ...listing(fs, `${path}/${entry.name}`).map((n) => `${entry.name}/${n}`),
            ]
          : [entry.name],
      )
      .sort();

  it("searches every directory a path goes through", () => {
    const fs = create();
    fs.mkdir("/nx/sub", true, 0o755);
    put(fs, "/nx/f", "data");
    fs.symlink("/nx/f", "/link");
    fs.symlink("f", "/nx/rel");
    fs.chmod("/nx", 0o644, true);

    // The directory itself, and a trailing slash, look nothing up in it.
    expect(mode(fs, "/nx")).toBe(0o644);
    fs.stat("/nx/", true);
    const paths = ["/nx/f", "/nx/missing", "/nx/.", "/nx/./", "/nx/..", "/nx/sub/.."];
    expect(paths.map((path) => failure(() => fs.stat(path, true)))).toMatchObject(
      paths.map((path) => refused("stat", path)),
    );
    expect(failure(() => fs.stat("/nx/f", false))).toMatchObject({
      ...refused("lstat", "/nx/f"),
      message: "EACCES: permission denied, lstat '/nx/f'",
    });
    expect(fs.exists("/nx/f")).toBe(false);
    // A link's target is walked the same way.
    expect(failure(() => fs.stat("/link", true))).toMatchObject(refused("stat", "/link"));
    fs.stat("/link", false);
    expect(failure(() => fs.realpath("/nx/f"))).toMatchObject(refused("realpath", "/nx/f"));
    expect(failure(() => fs.readlink("/nx/rel"))).toMatchObject(refused("readlink", "/nx/rel"));
    expect(failure(() => fs.readFile("/nx/f"))).toMatchObject(refused("open", "/nx/f"));
    expect(failure(() => fs.chmod("/nx/f", 0o600, true))).toMatchObject(refused("chmod", "/nx/f"));
    expect(failure(() => fs.utimes("/nx/f", 1, 1, true))).toMatchObject(refused("utime", "/nx/f"));
    expect(failure(() => fs.access("/nx/f", F_OK))).toMatchObject(refused("access", "/nx/f"));
    // Listing needs read, not search.
    expect(fs.readdir("/nx").map((entry) => entry.name)).toEqual(["f", "rel", "sub"]);

    // Search alone walks through but cannot list.
    fs.chmod("/nx", 0o311, true);
    expect(read(fs, "/nx/f")).toBe("data");
    expect(read(fs, "/link")).toBe("data");
    expect(failure(() => fs.readdir("/nx"))).toMatchObject(refused("scandir", "/nx"));
    expect(failure(() => fs.open("/nx", O_RDONLY, 0))).toMatchObject(refused("open", "/nx"));

    // The root is a directory like any other; the page's view checks nothing.
    fs.chmod("/", 0o600, true);
    fs.stat("/", true);
    expect(failure(() => fs.stat("/.", true))).toMatchObject(refused("stat", "/."));
    expect(failure(() => fs.stat("/link", false))).toMatchObject(refused("lstat", "/link"));
    fs.privileged.stat("/nx/f", true);
    expect(fs.privileged.exists("/nx/f")).toBe(true);
    fs.privileged.chmod("/", 0o755, true);
    expect(fs.exists("/nx/f")).toBe(true);
  });

  it("reads and writes by the file's own bits", () => {
    const fs = create();
    put(fs, "/f", "data");
    fs.chmod("/f", 0, true);
    expect(failure(() => fs.readFile("/f"))).toMatchObject({
      ...refused("open", "/f"),
      message: "EACCES: permission denied, open '/f'",
    });
    expect(failure(() => put(fs, "/f", "x"))).toMatchObject(refused("open", "/f"));
    // Its owner may still look, change its mode and set its times.
    expect(mode(fs, "/f")).toBe(0);
    fs.utimes("/f", 5, 5, true);
    fs.chmod("/f", 0o444, true);
    expect(read(fs, "/f")).toBe("data");
    const flagSets = [O_WRONLY, O_RDWR, O_RDONLY | O_TRUNC, 3, O_WRONLY | O_APPEND];
    expect(flagSets.map((flags) => failure(() => fs.open("/f", flags, 0)))).toMatchObject(
      flagSets.map(() => refused("open", "/f")),
    );
    expect(read(fs, "/f")).toBe("data");
    expect(failure(() => fs.truncate("/f", 0))).toMatchObject(refused("open", "/f"));
    fs.open("/f", O_RDONLY | O_CREAT, 0).close();
    expect(failure(() => fs.open("/f", O_RDONLY | O_CREAT | O_EXCL, 0))).toMatchObject({
      code: "EEXIST",
    });

    fs.chmod("/f", 0o222, true);
    expect(failure(() => fs.readFile("/f"))).toMatchObject(refused("open", "/f"));
    // Truncating by path opens the file for reading and writing, as Node does.
    expect(failure(() => fs.truncate("/f", 0))).toMatchObject(refused("open", "/f"));
    const file = fs.open("/f", O_WRONLY | O_TRUNC, 0);
    // An open file is checked when it is opened, not later.
    fs.chmod("/f", 0, true);
    file.write(encoder.encode("ok"), null);
    file.truncate(1);
    file.chmod(0o600);
    file.close();
    expect(read(fs, "/f")).toBe("o");

    // A new file is not checked against the mode it is made with.
    const made = fs.open("/new", O_RDWR | O_CREAT, 0o444);
    made.write(encoder.encode("x"), null);
    made.close();
    expect(mode(fs, "/new")).toBe(0o444);
    expect(failure(() => put(fs, "/new", "y"))).toMatchObject(refused("open", "/new"));
    // The page saves whatever the mode.
    put(fs.privileged, "/new", "saved");
    expect(read(fs, "/new")).toBe("saved");
  });

  it("changes a directory only with write and search on it", () => {
    const fs = create();
    fs.mkdir("/d/sub", true, 0o755);
    put(fs, "/d/in", "in");
    put(fs, "/out", "out");
    fs.chmod("/d", 0o555, true);
    expect(failure(() => put(fs, "/d/new", ""))).toMatchObject(refused("open", "/d/new"));
    expect(failure(() => fs.mkdir("/d/m", false, 0o755))).toMatchObject(refused("mkdir", "/d/m"));
    expect(failure(() => fs.mkdir("/d/m/n", true, 0o755))).toMatchObject(
      refused("mkdir", "/d/m/n"),
    );
    expect(failure(() => fs.unlink("/d/in"))).toMatchObject(refused("unlink", "/d/in"));
    expect(failure(() => fs.rmdir("/d/sub"))).toMatchObject(refused("rmdir", "/d/sub"));
    expect(failure(() => fs.rm("/d/in", false, true))).toMatchObject(refused("rm", "/d/in"));
    expect(failure(() => fs.rename("/d/in", "/d/in2"))).toMatchObject(
      refused("rename", "/d/in", "/d/in2"),
    );
    expect(failure(() => fs.rename("/d/in", "/moved"))).toMatchObject(
      refused("rename", "/d/in", "/moved"),
    );
    expect(failure(() => fs.rename("/out", "/d/out"))).toMatchObject(
      refused("rename", "/out", "/d/out"),
    );
    expect(failure(() => fs.symlink("in", "/d/l"))).toMatchObject(refused("symlink", "in", "/d/l"));
    expect(failure(() => fs.link("/out", "/d/hard"))).toMatchObject(
      refused("link", "/out", "/d/hard"),
    );
    expect(failure(() => fs.copyFile("/out", "/d/copy", 0))).toMatchObject(
      refused("copyfile", "/out", "/d/copy"),
    );
    expect(failure(() => fs.mkdtemp("/d/t-"))).toMatchObject(refused("mkdtemp", "/d/t-XXXXXX"));
    // Linux's order: what the name is comes first where it looks the name up
    // first, then the directory's permission, then the kind.
    expect(failure(() => fs.mkdir("/d/sub", false, 0))).toMatchObject({ code: "EEXIST" });
    expect(fs.mkdir("/d/sub", true, 0)).toBeUndefined();
    expect(failure(() => fs.unlink("/d/nope"))).toMatchObject({ code: "ENOENT" });
    expect(failure(() => fs.unlink("/d/sub"))).toMatchObject(refused("unlink", "/d/sub"));
    expect(failure(() => fs.rmdir("/d/in"))).toMatchObject(refused("rmdir", "/d/in"));
    expect(failure(() => fs.symlink("x", "/d/in"))).toMatchObject({ code: "EEXIST" });
    expect(failure(() => fs.link("/d", "/d/in"))).toMatchObject({ code: "EEXIST" });
    expect(failure(() => fs.link("/d/sub", "/d/l2"))).toMatchObject(
      refused("link", "/d/sub", "/d/l2"),
    );
    expect(failure(() => fs.link("/d/sub", "/l3"))).toMatchObject({ code: "EPERM" });
    // A file in it can still be changed: that needs only the file's own bits.
    put(fs, "/d/in", "changed");
    expect(fs.readdir("/d").map((entry) => entry.name)).toEqual(["in", "sub"]);

    // Search alone is not enough, and neither is write alone.
    fs.chmod("/d", 0o355, true);
    put(fs, "/d/made", "1");
    fs.chmod("/d", 0o655, true);
    expect(failure(() => fs.unlink("/d/made"))).toMatchObject(refused("unlink", "/d/made"));
    fs.privileged.unlink("/d/made");
    fs.privileged.mkdir("/d/by-page", false, 0o755);
    fs.privileged.rename("/d/by-page", "/by-page");
  });

  it("moves a directory to another parent only with write on it", () => {
    const fs = create();
    fs.mkdir("/a/mv", true, 0o755);
    fs.mkdir("/b", false, 0o755);
    fs.chmod("/a/mv", 0o555, true);
    expect(failure(() => fs.rename("/a/mv", "/b/mv"))).toMatchObject(
      refused("rename", "/a/mv", "/b/mv"),
    );
    fs.rename("/a/mv", "/a/renamed");
    fs.chmod("/a/renamed", 0o755, true);
    fs.rename("/a/renamed", "/b/mv");
    put(fs, "/a/f", "f");
    fs.chmod("/a/f", 0, true);
    fs.rename("/a/f", "/b/f");
    fs.mkdir("/b/full", false, 0o755);
    put(fs, "/b/full/x", "x");
    fs.mkdir("/c", false, 0o755);
    fs.chmod("/c", 0o555, true);
    expect(failure(() => fs.rename("/b/mv", "/b/full"))).toMatchObject({ code: "ENOTEMPTY" });
    expect(failure(() => fs.rename("/b/mv", "/b/f"))).toMatchObject({ code: "ENOTDIR" });
    // A directory's own write comes before whether the target is empty.
    expect(failure(() => fs.rename("/c", "/b/full"))).toMatchObject(
      refused("rename", "/c", "/b/full"),
    );
    fs.chmod("/b", 0o555, true);
    expect(failure(() => fs.rename("/b/mv", "/b/full"))).toMatchObject(
      refused("rename", "/b/mv", "/b/full"),
    );
    fs.rename("/b/f", "/b/f");
  });

  it("refuses a rename onto a directory the source is in before any permission", () => {
    // Linux's rename finds the target above the source (ENOTEMPTY) before it
    // asks whether either directory may be changed, whatever the source is.
    const fs = create();
    fs.mkdir("/p/q/r", true, 0o755);
    fs.mkdir("/p/q/x/y", true, 0o755);
    put(fs, "/p/q/f", "f");
    const onto = (from: string, to: string) => failure(() => fs.rename(from, to));
    const notEmpty = (from: string, to: string) => ({
      code: "ENOTEMPTY",
      syscall: "rename",
      path: from,
      dest: to,
    });
    for (const parentMode of [0o755, 0o555]) {
      fs.chmod("/p", parentMode, true);
      expect(onto("/p/q/r", "/p/q")).toMatchObject(notEmpty("/p/q/r", "/p/q"));
      expect(onto("/p/q/f", "/p/q")).toMatchObject(notEmpty("/p/q/f", "/p/q"));
      expect(onto("/p/q/x/y", "/p/q")).toMatchObject(notEmpty("/p/q/x/y", "/p/q"));
      expect(onto("/p/q/x/y", "/p")).toMatchObject(notEmpty("/p/q/x/y", "/p"));
    }
    // The source's own directory unwritable changes nothing either.
    fs.chmod("/p", 0o755, true);
    fs.chmod("/p/q", 0o555, true);
    expect(onto("/p/q/r", "/p/q")).toMatchObject(notEmpty("/p/q/r", "/p/q"));
    // The other way round is still EINVAL, and a target beside the source is
    // still asked about its directory.
    expect(onto("/p/q", "/p/q/r/in")).toMatchObject({ code: "EINVAL" });
    expect(onto("/p/q/r", "/p/q/x")).toMatchObject(refused("rename", "/p/q/r", "/p/q/x"));
    expect(listing(fs, "/p")).toEqual(["q/", "q/f", "q/r/", "q/x/", "q/x/y/"]);
  });

  it("lists and removes names in the order of their code points", () => {
    // 😀 is U+1F600 (UTF-8 F0.., UTF-16 D83D DE00) and ｱ is U+FF71 (UTF-8
    // EF.., UTF-16 FF71): by code point and by UTF-8 byte ｱ comes first, by
    // UTF-16 unit 😀 does.
    const fs = create();
    fs.mkdir("/t/ｱ", true, 0o755);
    put(fs, "/t/ｱ/in", "x");
    put(fs, "/t/😀", "x");
    put(fs, "/t/é", "x");
    put(fs, "/t/z", "x");
    put(fs, "/t/\u{10000}", "x");
    put(fs, "/t/", "x");
    put(fs, "/t/퟿", "x");
    const names = () => fs.readdir("/t").map((entry) => entry.name);
    expect(names()).toEqual(["z", "é", "퟿", "", "ｱ", "\u{10000}", "😀"]);
    // The removal stops at ｱ, which may not be emptied: only what readdir
    // lists before it is gone.
    fs.chmod("/t/ｱ", 0o555, true);
    expect(failure(() => fs.rm("/t", true, false))).toMatchObject(refused("rm", "/t"));
    expect(names()).toEqual(["ｱ", "\u{10000}", "😀"]);
    expect(listing(fs, "/t")).toEqual(["ｱ/", "ｱ/in", "\u{10000}", "😀"].sort());
  });

  it("removes a tree in the order of names up to the first refusal, its own entry last", () => {
    const fs = create();
    fs.mkdir("/t/a", true, 0o755);
    put(fs, "/t/a/f1", "1");
    fs.mkdir("/t/b/d", true, 0o755);
    put(fs, "/t/b/d/f3", "3");
    put(fs, "/t/b/f2", "2");
    fs.mkdir("/t/c", true, 0o755);
    put(fs, "/t/c/f4", "4");
    put(fs, "/t/top", "t");
    fs.chmod("/t/b", 0o555, true);
    // As Node's rm (std::filesystem::remove_all) on Linux: entry by entry, in
    // the order readdir lists them, a directory's contents before it, up to
    // the first refusal. a goes; b/d is emptied, then b refuses to let it go.
    expect(failure(() => fs.rm("/t", true, true))).toMatchObject({
      ...refused("rm", "/t"),
      message: "EACCES: permission denied, rm '/t'",
    });
    expect(listing(fs, "/t")).toEqual(["b/", "b/d/", "b/f2", "c/", "c/f4", "top"]);
    // A directory it may not read stops it too, even an empty one: Node's rm
    // opens each.
    fs.chmod("/t/b", 0o755, true);
    fs.mkdir("/t/c/empty", false, 0o755);
    fs.chmod("/t/c/empty", 0o311, true);
    expect(failure(() => fs.rm("/t", true, false))).toMatchObject(refused("rm", "/t"));
    expect(listing(fs, "/t")).toEqual(["c/", "c/empty/", "c/f4", "top"]);
    expect(failure(() => fs.rm("/t/c/empty", true, false))).toMatchObject(
      refused("rm", "/t/c/empty"),
    );
    // A directory inside one it may not search is not opened: what it holds
    // stays, though that directory itself could be emptied.
    fs.mkdir("/t/c/empty/in", false, 0o755);
    put(fs, "/t/c/empty/in/f5", "5");
    fs.chmod("/t/c/empty", 0o666, true);
    expect(failure(() => fs.rm("/t/c/empty", true, false))).toMatchObject(
      refused("rm", "/t/c/empty"),
    );
    expect(listing(fs, "/t/c/empty")).toEqual(["in/", "in/f5"]);
    fs.privileged.rm("/t/c/empty/in", true, false);
    // An empty one needs only read; a file needs nothing.
    fs.chmod("/t/c/empty", 0o444, true);
    fs.chmod("/t/c/f4", 0, true);
    // The tree goes, then its own entry, which its directory may refuse.
    fs.chmod("/", 0o555, true);
    expect(failure(() => fs.rm("/t", true, false))).toMatchObject(refused("rm", "/t"));
    expect(fs.exists("/t")).toBe(true);
    expect(fs.readdir("/t")).toEqual([]);
    fs.chmod("/", 0o755, true);
    fs.rm("/t", true, false);
    expect(fs.totals()).toEqual({ inodes: 1, bytes: 0 });
    // The page removes whatever the modes.
    fs.mkdir("/u/v", true, 0o755);
    put(fs, "/u/v/w", "w");
    fs.chmod("/u/v", 0, true);
    fs.chmod("/u", 0, true);
    fs.privileged.rm("/u", true, false);
    expect(fs.totals()).toEqual({ inodes: 1, bytes: 0 });
  });

  it("copies from a readable file to a writable place", () => {
    const fs = create();
    put(fs, "/src", "data");
    put(fs, "/dst", "old");
    fs.chmod("/src", 0o222, true);
    expect(failure(() => fs.copyFile("/src", "/new", 0))).toMatchObject({
      ...refused("copyfile", "/src", "/new"),
      message: "EACCES: permission denied, copyfile '/src' -> '/new'",
    });
    fs.chmod("/src", 0o444, true);
    fs.copyFile("/src", "/new", 0);
    expect(mode(fs, "/new")).toBe(0o444);
    fs.chmod("/dst", 0o444, true);
    expect(failure(() => fs.copyFile("/src", "/dst", 0))).toMatchObject(
      refused("copyfile", "/src", "/dst"),
    );
    expect(read(fs, "/dst")).toBe("old");
    expect(failure(() => fs.copyFile("/src", "/src", 0))).toMatchObject(
      refused("copyfile", "/src", "/src"),
    );
    expect(failure(() => fs.copyFile("/src", "/dst", COPYFILE_EXCL))).toMatchObject({
      code: "EEXIST",
    });
  });

  it("asks the destination of a copy before it finds a source that is no file", () => {
    // libuv opens the source, then the destination, and only reading a
    // directory fails (EISDIR): whatever refuses the destination comes first.
    const fs = create();
    fs.mkdir("/d", false, 0o755);
    put(fs, "/f", "old");
    put(fs, "/wo", "old");
    fs.mkdir("/ro", false, 0o755);
    fs.mkdir("/nx", false, 0o755);
    fs.chmod("/wo", 0o444, true);
    fs.chmod("/ro", 0o555, true);
    fs.chmod("/nx", 0o600, true);
    const copy = (to: string, mode = 0) => failure(() => fs.copyFile("/d", to, mode));
    expect(copy("/nope/x")).toMatchObject({ code: "ENOENT", path: "/d", dest: "/nope/x" });
    expect(copy("/f", COPYFILE_EXCL)).toMatchObject({ code: "EEXIST" });
    expect(copy("/ro/new")).toMatchObject(refused("copyfile", "/d", "/ro/new"));
    expect(copy("/nx/new")).toMatchObject(refused("copyfile", "/d", "/nx/new"));
    expect(copy("/wo")).toMatchObject(refused("copyfile", "/d", "/wo"));
    // Then the directory: nothing is made, and what was there is kept.
    for (const to of ["/f", "/new", "/new/", "/d"]) {
      expect(copy(to)).toMatchObject({ code: "EISDIR", syscall: "copyfile", path: "/d", dest: to });
    }
    expect(read(fs, "/f")).toBe("old");
    expect(fs.exists("/new")).toBe(false);
    // A directory it may not read is refused as the source, first of all.
    fs.chmod("/d", 0o311, true);
    expect(copy("/nope/x")).toMatchObject(refused("copyfile", "/d", "/nope/x"));
  });

  it("answers access by the owner bits, and as root when unchecked", () => {
    const fs = create();
    put(fs, "/f", "x");
    fs.mkdir("/d", false, 0o755);
    const allowed = (view: TestFs["privileged"], path: string, bits: number) => {
      try {
        view.access(path, bits);
        return true;
      } catch {
        return false;
      }
    };
    fs.chmod("/f", 0o100, true);
    expect(allowed(fs, "/f", X_OK)).toBe(true);
    expect(allowed(fs, "/f", F_OK)).toBe(true);
    expect(allowed(fs, "/f", R_OK | X_OK)).toBe(false);
    fs.chmod("/f", 0o077, true);
    expect([R_OK, W_OK, X_OK].map((bits) => allowed(fs, "/f", bits))).toEqual([
      false,
      false,
      false,
    ]);
    fs.chmod("/f", 0o600, true);
    expect(allowed(fs, "/f", R_OK | W_OK)).toBe(true);
    expect(allowed(fs, "/f", X_OK)).toBe(false);
    expect(allowed(fs, "/d", R_OK | W_OK | X_OK)).toBe(true);
    fs.chmod("/d", 0o600, true);
    expect(failure(() => fs.access("/d", X_OK))).toMatchObject(refused("access", "/d"));
    expect(allowed(fs.privileged, "/d", X_OK)).toBe(true);
    expect(allowed(fs.privileged, "/f", R_OK | W_OK)).toBe(true);
    expect(allowed(fs.privileged, "/f", X_OK)).toBe(false);
    fs.chmod("/f", 0o010, true);
    expect(allowed(fs.privileged, "/f", X_OK)).toBe(true);
  });

  it("watches only what it may read", () => {
    const fs = create();
    put(fs, "/f", "x");
    fs.chmod("/f", 0o200, true);
    expect(failure(() => fs.watch("/f", false, () => {}))).toMatchObject(refused("watch", "/f"));
    const events: string[] = [];
    const stop = fs.privileged.watch("/f", false, (event) => events.push(event.eventType));
    fs.chmod("/f", 0o600, true);
    stop();
    expect(events).toEqual(["change"]);
  });

  it("answers a directory root owns by its others' bits, and lets only its owner change it", () => {
    const fs = create();
    fs.mkdir("/dev", false, 0o755);
    put(fs, "/dev/kept", "k");
    fs.symlink("/dev", "/devlink");
    const owner = (path: string, follow = true) => {
      const stat = fs.stat(path, follow);
      return [(stat.mode & 0o7777).toString(8), stat.uid, stat.gid];
    };
    const eperm = (syscall: string, path?: string) =>
      path === undefined ? { code: "EPERM", syscall } : { code: "EPERM", syscall, path };
    // Only the unchecked view gives a node to root.
    expect(failure(() => fs.giveToRoot("/dev"))).toMatchObject(eperm("chown", "/dev"));
    expect(owner("/dev")).toEqual(["755", 1, 1]);
    fs.privileged.giveToRoot("/dev");
    expect(owner("/dev")).toEqual(["755", 0, 0]);
    expect(owner("/devlink", false)).toEqual(["777", 1, 1]);
    expect(owner("/dev/kept")).toEqual(["644", 1, 1]);

    // The owner's bits are 7, but the others' (r-x) decide.
    fs.access("/dev", R_OK | X_OK);
    expect(failure(() => fs.access("/dev", W_OK))).toMatchObject(refused("access", "/dev"));
    expect(fs.readdir("/dev").map((entry) => entry.name)).toEqual(["kept"]);
    for (const path of ["/dev/x", "/devlink/x"]) {
      expect(failure(() => fs.open(path, WRITE | O_EXCL, 0o644))).toMatchObject(
        refused("open", path),
      );
      expect(failure(() => fs.mkdir(path, false, 0o755))).toMatchObject(refused("mkdir", path));
      expect(failure(() => fs.symlink("/tmp", path))).toMatchObject(
        refused("symlink", "/tmp", path),
      );
    }
    expect(failure(() => fs.mkdir("/dev/a/b", true, 0o755))).toMatchObject(
      refused("mkdir", "/dev/a/b"),
    );
    expect(failure(() => fs.unlink("/dev/kept"))).toMatchObject(refused("unlink", "/dev/kept"));
    expect(failure(() => fs.rename("/dev/kept", "/kept"))).toMatchObject(
      refused("rename", "/dev/kept", "/kept"),
    );
    expect(failure(() => fs.rm("/dev/kept", false, true))).toMatchObject(
      refused("rm", "/dev/kept"),
    );
    fs.rm("/dev/missing", false, true);
    // The owner alone changes its mode and times, by path or open file.
    for (const mode of [0o755, 0o777]) {
      expect(failure(() => fs.chmod("/dev", mode, true))).toMatchObject(eperm("chmod", "/dev"));
    }
    expect(failure(() => fs.chmod("/devlink", 0o777, true))).toMatchObject(
      eperm("chmod", "/devlink"),
    );
    expect(failure(() => fs.utimes("/dev", 1, 1, true))).toMatchObject(eperm("utime", "/dev"));
    const dir = fs.open("/dev", O_RDONLY, 0);
    expect(failure(() => dir.chmod(0o777))).toMatchObject(eperm("fchmod"));
    expect(failure(() => dir.utimes(1, 1))).toMatchObject(eperm("futime"));
    dir.close();
    expect(owner("/dev")).toEqual(["755", 0, 0]);
    // What it holds stays the user's.
    fs.chmod("/dev/kept", 0o600, true);
    expect(read(fs, "/dev/kept")).toBe("k");
    // Unchecked calls are root's.
    put(fs.privileged, "/dev/made", "m");
    fs.privileged.chmod("/dev", 0o700, true);
    expect(failure(() => fs.readdir("/dev"))).toMatchObject(refused("scandir", "/dev"));
    expect(failure(() => fs.stat("/dev/kept", true))).toMatchObject(refused("stat", "/dev/kept"));
  });

  it("keeps the entry of a node root owns, whatever path reaches it", () => {
    const fs = create();
    fs.privileged.mkdir("/dev", false, 0o755);
    put(fs.privileged, "/dev/kept", "k");
    fs.privileged.giveToRoot("/dev");
    // `/` is the user's: only the rule for root's node refuses these.
    fs.symlink("/", "/root");
    fs.mkdir("/empty", false, 0o755);
    for (const path of ["/dev", "/root/dev", "/root/dev/"]) {
      expect(failure(() => fs.rmdir(path))).toMatchObject(refused("rmdir", path));
      expect(failure(() => fs.rm(path, true, true))).toMatchObject(refused("rm", path));
      expect(failure(() => fs.rename(path, "/moved"))).toMatchObject(
        refused("rename", path, "/moved"),
      );
      expect(failure(() => fs.rename("/empty", path))).toMatchObject(
        refused("rename", "/empty", path),
      );
    }
    // Before the kind, as Linux's `may_delete`: not EISDIR.
    expect(failure(() => fs.unlink("/root/dev"))).toMatchObject(refused("unlink", "/root/dev"));
    expect(read(fs, "/dev/kept")).toBe("k");
    // A tree that holds root's node goes as far as it may, then stops there.
    fs.privileged.mkdir("/top", false, 0o755);
    put(fs, "/top/a", "a");
    fs.privileged.mkdir("/top/b", false, 0o755);
    fs.privileged.giveToRoot("/top/b");
    put(fs, "/top/c", "c");
    expect(failure(() => fs.rm("/top", true, false))).toMatchObject(refused("rm", "/top"));
    expect(listing(fs, "/top")).toEqual(["b/", "c"]);
    // The unchecked calls are root's.
    fs.privileged.rename("/root/dev", "/dev2");
    expect(fs.exists("/dev")).toBe(false);
  });

  it("sets the times of a node root owns to now only where it may write", () => {
    const fs = create();
    fs.privileged.mkdir("/dev", false, 0o755);
    put(fs.privileged, "/open", "o");
    fs.privileged.chmod("/open", 0o666, true);
    fs.privileged.giveToRoot("/dev");
    fs.privileged.giveToRoot("/open");
    expect(failure(() => fs.utimes("/open", 1, 1, true))).toMatchObject({
      code: "EPERM",
      syscall: "utime",
    });
    expect(failure(() => fs.utimes("/open", null, 1, true))).toMatchObject({ code: "EPERM" });
    const before = fs.stat("/open", true).ctimeMs;
    fs.utimes("/open", null, null, true);
    const stat = fs.stat("/open", true);
    // One moment: both times and the change time.
    expect([stat.atimeMs, stat.mtimeMs]).toEqual([stat.ctimeMs, stat.ctimeMs]);
    expect(stat.ctimeMs).toBeGreaterThanOrEqual(before);
    expect(failure(() => fs.utimes("/dev", null, null, true))).toMatchObject(
      refused("utime", "/dev"),
    );
    // The owner needs no write permission for it.
    put(fs, "/mine", "m");
    fs.chmod("/mine", 0o444, true);
    fs.utimes("/mine", null, null, true);
  });

  it("keeps the checks on after a privileged call fails", () => {
    const fs = create();
    put(fs, "/f", "x");
    fs.chmod("/f", 0, true);
    expect(() => fs.privileged.readFile("/missing")).toThrow(/ENOENT/);
    expect(failure(() => fs.readFile("/f"))).toMatchObject(refused("open", "/f"));
    expect(decoder.decode(fs.privileged.readFile("/f"))).toBe("x");
  });
});

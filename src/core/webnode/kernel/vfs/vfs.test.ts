// @vitest-environment node
// Behaviour of the in-memory filesystem: every operation, its POSIX errors,
// symbolic links, open files, timestamps and watches. Every case runs against
// the TypeScript filesystem and the shared one (sharedfs), which must agree.
import { describe, expect, it } from "vitest";
import type { SystemError } from "../../errors";
import {
  COPYFILE_EXCL,
  F_OK,
  O_APPEND,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  R_OK,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  X_OK,
  type VfsApi,
  type VfsWatchEvent,
} from "./types";
import { createSharedFilesystem } from "../../sharedfs/boot";
import { normalizePath, Vfs } from "./vfs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WRITE = O_WRONLY | O_CREAT | O_TRUNC;

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function text(data: Uint8Array): string {
  return decoder.decode(data);
}

function put(vfs: VfsApi, path: string, content: string): void {
  vfs.writeFile(path, bytes(content), WRITE, 0o666);
}

function read(vfs: VfsApi, path: string): string {
  return text(vfs.readFile(path));
}

/** The system error `action` throws, reduced to the fields a test compares. */
function failure(action: () => unknown): Partial<SystemError> {
  try {
    action();
  } catch (error) {
    const { code, syscall, path, dest } = error as SystemError;
    return { code, syscall, path, dest };
  }
  throw new Error("expected the call to throw");
}

function watchAll(vfs: VfsApi, path: string, recursive: boolean): VfsWatchEvent[] {
  const events: VfsWatchEvent[] = [];
  vfs.watch(path, recursive, (event) => events.push(event));
  return events;
}

/** A filesystem under test: the contract plus `totals`, which both have. */
type TestFs = VfsApi & { totals(): { inodes: number; bytes: number } };

const IMPLEMENTATIONS: [name: string, create: (now: () => number) => TestFs][] = [
  ["Vfs", (now) => new Vfs({ now })],
  [
    "SharedFs",
    (now) => {
      const shared = createSharedFilesystem({ now });
      if (shared === null) {
        throw new Error("this engine cannot make the shared filesystem");
      }
      return shared.fs;
    },
  ],
];

describe("normalizePath", () => {
  it("collapses slashes, dots and dot-dots", () => {
    expect(normalizePath("/a//b/./c/../d/")).toBe("/a/b/d");
    expect(normalizePath("/../..")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/a/b")).toBe("/a/b");
    expect(normalizePath("a/../../b")).toBe("../b");
    expect(normalizePath("")).toBe(".");
    expect(normalizePath("/a/.")).toBe("/a");
  });
});

describe.each(IMPLEMENTATIONS)("%s", (_name, create) => {
  function setup(): { vfs: TestFs; tick: (ms?: number) => number } {
    let time = 1000;
    const vfs = create(() => time);
    return {
      vfs,
      tick: (ms = 1) => {
        time += ms;
        return time;
      },
    };
  }

  describe("root and paths", () => {
    it("has a root directory with mode 0755", () => {
      const { vfs } = setup();
      const stat = vfs.stat("/", true);
      expect(stat.mode).toBe(S_IFDIR | 0o755);
      expect(vfs.readdir("/")).toEqual([]);
    });

    it("rejects relative paths with EINVAL", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.stat("a/b", true))).toMatchObject({
        code: "EINVAL",
        syscall: "stat",
        path: "a/b",
      });
    });

    it("reports ENOENT for an empty path", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.stat("", true))).toMatchObject({ code: "ENOENT", syscall: "stat" });
    });

    it("normalizes //, . and .. while resolving", () => {
      const { vfs } = setup();
      vfs.mkdir("/a", false, 0o777);
      put(vfs, "/a/f", "x");
      expect(read(vfs, "//a/.//f")).toBe("x");
      expect(read(vfs, "/a/../a/./f")).toBe("x");
      expect(read(vfs, "/../../a/f")).toBe("x");
    });

    it("treats .. through a missing directory as ENOENT", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.stat("/missing/../", true))).toMatchObject({ code: "ENOENT" });
    });

    it("requires a directory for a trailing slash", () => {
      const { vfs } = setup();
      put(vfs, "/f", "x");
      expect(failure(() => vfs.stat("/f/", true))).toMatchObject({
        code: "ENOTDIR",
        syscall: "stat",
        path: "/f/",
      });
      expect(failure(() => vfs.readFile("/f/."))).toMatchObject({ code: "ENOTDIR" });
      vfs.mkdir("/d", false, 0o777);
      expect(vfs.stat("/d/", true).mode & S_IFMT).toBe(S_IFDIR);
    });

    it("reports ENOTDIR when a middle component is a file", () => {
      const { vfs } = setup();
      put(vfs, "/f", "x");
      expect(failure(() => vfs.stat("/f/x", true))).toMatchObject({
        code: "ENOTDIR",
        syscall: "stat",
        path: "/f/x",
      });
      expect(failure(() => put(vfs, "/f/x", "y"))).toMatchObject({
        code: "ENOTDIR",
        syscall: "open",
      });
    });
  });

  describe("files", () => {
    it("writes and reads a file", () => {
      const { vfs } = setup();
      put(vfs, "/hello.txt", "hello");
      expect(read(vfs, "/hello.txt")).toBe("hello");
      expect(vfs.exists("/hello.txt")).toBe(true);
      expect(vfs.exists("/nope")).toBe(false);
    });

    it("returns a copy from readFile", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      const first = vfs.readFile("/f");
      first[0] = 0;
      expect(read(vfs, "/f")).toBe("abc");
    });

    it("does not keep a reference to the caller's buffer", () => {
      const { vfs } = setup();
      const data = bytes("abc");
      vfs.writeFile("/f", data, WRITE, 0o644);
      data[0] = 120;
      expect(read(vfs, "/f")).toBe("abc");
    });

    it("creates files with mode 0644 after the umask", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(vfs.stat("/f", true).mode).toBe(S_IFREG | 0o644);
      vfs.writeFile("/g", bytes(""), WRITE, 0o777);
      expect(vfs.stat("/g", true).mode).toBe(S_IFREG | 0o755);
    });

    it("reports size, blocks and identity in stat", () => {
      const { vfs } = setup();
      put(vfs, "/f", "x".repeat(1025));
      const stat = vfs.stat("/f", true);
      expect(stat.size).toBe(1025);
      expect(stat.blocks).toBe(3);
      expect(stat.blksize).toBe(4096);
      expect(stat.uid).toBe(1);
      expect(stat.gid).toBe(1);
      expect(stat.dev).toBe(1);
      expect(stat.rdev).toBe(0);
      expect(stat.nlink).toBe(1);
    });

    it("gives every inode a unique, stable number", () => {
      const { vfs } = setup();
      put(vfs, "/a", "");
      put(vfs, "/b", "");
      const a = vfs.stat("/a", true).ino;
      expect(vfs.stat("/b", true).ino).not.toBe(a);
      vfs.rename("/a", "/c");
      expect(vfs.stat("/c", true).ino).toBe(a);
    });

    it("overwrites a file with writeFile", () => {
      const { vfs } = setup();
      put(vfs, "/f", "long content");
      put(vfs, "/f", "short");
      expect(read(vfs, "/f")).toBe("short");
    });

    it("appends with O_APPEND", () => {
      const { vfs } = setup();
      put(vfs, "/f", "a");
      vfs.writeFile("/f", bytes("b"), O_WRONLY | O_CREAT | O_APPEND, 0o644);
      vfs.writeFile("/f", bytes("c"), O_WRONLY | O_CREAT | O_APPEND, 0o644);
      expect(read(vfs, "/f")).toBe("abc");
    });

    it("raises ENOENT reading a missing file", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.readFile("/nope"))).toMatchObject({
        code: "ENOENT",
        syscall: "open",
        path: "/nope",
      });
    });

    it("raises EISDIR reading a directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      expect(failure(() => vfs.readFile("/d"))).toMatchObject({ code: "EISDIR", syscall: "read" });
    });

    it("raises EISDIR writing to a directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      expect(failure(() => put(vfs, "/d", "x"))).toMatchObject({
        code: "EISDIR",
        syscall: "open",
        path: "/d",
      });
    });

    it("raises EISDIR creating a file at a path with a trailing slash", () => {
      const { vfs } = setup();
      expect(failure(() => put(vfs, "/new/", "x"))).toMatchObject({
        code: "EISDIR",
        syscall: "open",
        path: "/new/",
      });
    });

    it("raises ENOENT writing into a missing directory", () => {
      const { vfs } = setup();
      expect(failure(() => put(vfs, "/no/f", "x"))).toMatchObject({
        code: "ENOENT",
        syscall: "open",
        path: "/no/f",
      });
    });

    it("reads a 1 MB file quickly", () => {
      const { vfs } = setup();
      const data = new Uint8Array(1024 * 1024).fill(7);
      vfs.writeFile("/big", data, WRITE, 0o644);
      vfs.readFile("/big");
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        vfs.readFile("/big");
      }
      expect((performance.now() - start) / 20).toBeLessThan(1);
      expect(vfs.readFile("/big")).toEqual(data);
    });
  });

  describe("open files", () => {
    it("reads and writes at the file offset", () => {
      const { vfs } = setup();
      const file = vfs.open("/f", O_RDWR | O_CREAT, 0o644);
      expect(file.write(bytes("hello"), null)).toBe(5);
      expect(file.write(bytes(" world"), null)).toBe(6);
      expect(text(file.read(5, 0))).toBe("hello");
      expect(text(file.read(100, null))).toBe("");
      file.close();
      const reader = vfs.open("/f", O_RDONLY, 0);
      expect(text(reader.read(5, null))).toBe("hello");
      expect(text(reader.read(100, null))).toBe(" world");
      expect(reader.read(10, null).length).toBe(0);
      reader.close();
    });

    it("leaves the offset alone for positioned reads and writes", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abcdef");
      const file = vfs.open("/f", O_RDWR, 0);
      expect(text(file.read(2, 3))).toBe("de");
      expect(text(file.read(2, null))).toBe("ab");
      file.write(bytes("XY"), 4);
      expect(text(file.read(10, null))).toBe("cdXY");
      file.close();
    });

    it("zero-fills a gap when writing past the end", () => {
      const { vfs } = setup();
      const file = vfs.open("/sparse", O_RDWR | O_CREAT, 0o644);
      file.write(bytes("a"), 0);
      file.write(bytes("b"), 5);
      file.close();
      expect(Array.from(vfs.readFile("/sparse"))).toEqual([97, 0, 0, 0, 0, 98]);
    });

    it("zero-fills a region that was truncated away and regrown", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abcdef");
      vfs.truncate("/f", 2);
      const file = vfs.open("/f", O_RDWR, 0);
      file.write(bytes("z"), 5);
      file.close();
      expect(Array.from(vfs.readFile("/f"))).toEqual([97, 98, 0, 0, 0, 122]);
    });

    it("always writes at the end with O_APPEND", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      const file = vfs.open("/f", O_WRONLY | O_APPEND, 0);
      file.write(bytes("d"), 0);
      file.write(bytes("e"), null);
      file.close();
      expect(read(vfs, "/f")).toBe("abcde");
    });

    it("grows by appending many small writes", () => {
      const { vfs } = setup();
      const file = vfs.open("/log", O_WRONLY | O_CREAT | O_APPEND, 0o644);
      for (let i = 0; i < 10000; i++) {
        file.write(bytes("x"), null);
      }
      file.close();
      expect(vfs.stat("/log", true).size).toBe(10000);
    });

    it("truncates on open with O_TRUNC", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      vfs.open("/f", O_WRONLY | O_TRUNC, 0).close();
      expect(read(vfs, "/f")).toBe("");
    });

    it("fails O_CREAT|O_EXCL on an existing file with EEXIST", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      expect(failure(() => vfs.open("/f", O_WRONLY | O_CREAT | O_EXCL, 0))).toMatchObject({
        code: "EEXIST",
        syscall: "open",
        path: "/f",
      });
    });

    it("fails O_CREAT|O_EXCL on a dangling symlink with EEXIST", () => {
      const { vfs } = setup();
      vfs.symlink("/nowhere", "/link");
      expect(failure(() => vfs.open("/link", O_WRONLY | O_CREAT | O_EXCL, 0))).toMatchObject({
        code: "EEXIST",
      });
      expect(vfs.exists("/nowhere")).toBe(false);
    });

    it("creates the target of a dangling symlink with O_CREAT", () => {
      const { vfs } = setup();
      vfs.symlink("/target", "/link");
      put(vfs, "/link", "via link");
      expect(read(vfs, "/target")).toBe("via link");
    });

    it("raises ENOENT opening a missing file without O_CREAT", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.open("/f", O_RDONLY, 0))).toMatchObject({
        code: "ENOENT",
        syscall: "open",
        path: "/f",
      });
    });

    it("raises ENOTDIR for O_DIRECTORY on a file", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(failure(() => vfs.open("/f", O_RDONLY | O_DIRECTORY, 0))).toMatchObject({
        code: "ENOTDIR",
        syscall: "open",
        path: "/f",
      });
    });

    it("raises ELOOP for O_NOFOLLOW on a symlink", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      vfs.symlink("/f", "/link");
      expect(failure(() => vfs.open("/link", O_RDONLY | O_NOFOLLOW, 0))).toMatchObject({
        code: "ELOOP",
        syscall: "open",
        path: "/link",
      });
    });

    it("opens a directory read-only, where reads raise EISDIR", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      const dir = vfs.open("/d", O_RDONLY | O_DIRECTORY, 0);
      expect(dir.stat().mode & S_IFMT).toBe(S_IFDIR);
      expect(failure(() => dir.read(1, null))).toMatchObject({ code: "EISDIR", syscall: "read" });
      dir.close();
      expect(failure(() => vfs.open("/d", O_RDWR, 0))).toMatchObject({
        code: "EISDIR",
        syscall: "open",
        path: "/d",
      });
    });

    it("raises EBADF after close", () => {
      const { vfs } = setup();
      const file = vfs.open("/f", O_RDWR | O_CREAT, 0o644);
      file.close();
      expect(failure(() => file.read(1, null))).toMatchObject({ code: "EBADF", syscall: "read" });
      expect(failure(() => file.write(bytes("x"), null))).toMatchObject({
        code: "EBADF",
        syscall: "write",
      });
      expect(failure(() => file.stat())).toMatchObject({ code: "EBADF", syscall: "fstat" });
      expect(failure(() => file.close())).toMatchObject({ code: "EBADF", syscall: "close" });
    });

    it("raises EBADF writing a read-only file and reading a write-only one", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      const reader = vfs.open("/f", O_RDONLY, 0);
      expect(failure(() => reader.write(bytes("x"), null))).toMatchObject({
        code: "EBADF",
        syscall: "write",
      });
      reader.close();
      const writer = vfs.open("/f", O_WRONLY, 0);
      expect(failure(() => writer.read(1, null))).toMatchObject({ code: "EBADF", syscall: "read" });
      writer.close();
    });

    it("raises EINVAL for ftruncate on a read-only file", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      const reader = vfs.open("/f", O_RDONLY, 0);
      expect(failure(() => reader.truncate(0))).toMatchObject({
        code: "EINVAL",
        syscall: "ftruncate",
      });
      reader.close();
    });

    it("keeps an unlinked file readable until it is closed", () => {
      const { vfs } = setup();
      put(vfs, "/f", "still here");
      const before = vfs.totals();
      const file = vfs.open("/f", O_RDWR, 0);
      vfs.unlink("/f");
      expect(vfs.exists("/f")).toBe(false);
      expect(text(file.read(100, 0))).toBe("still here");
      file.write(bytes("!"), null);
      expect(file.stat().nlink).toBe(0);
      expect(vfs.totals().inodes).toBe(before.inodes);
      file.close();
      expect(vfs.totals().inodes).toBe(before.inodes - 1);
      expect(vfs.totals().bytes).toBe(before.bytes - 10);
    });

    it("keeps an open file working after a rename", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      const file = vfs.open("/f", O_RDWR, 0);
      vfs.rename("/f", "/g");
      file.write(bytes("Z"), 0);
      file.close();
      expect(read(vfs, "/g")).toBe("Zbc");
    });

    it("supports fchmod, futimes and ftruncate", () => {
      const { vfs, tick } = setup();
      put(vfs, "/f", "abcdef");
      const file = vfs.open("/f", O_RDWR, 0);
      file.chmod(0o600);
      file.utimes(5, 6);
      tick();
      file.truncate(3);
      const stat = file.stat();
      expect(stat.mode).toBe(S_IFREG | 0o600);
      expect(stat.atimeMs).toBe(5);
      expect(stat.size).toBe(3);
      file.close();
    });
  });

  describe("timestamps", () => {
    it("sets all four times at creation", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      const stat = vfs.stat("/f", true);
      expect([stat.atimeMs, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs]).toEqual([
        1000, 1000, 1000, 1000,
      ]);
    });

    it("updates mtime and ctime on write", () => {
      const { vfs, tick } = setup();
      put(vfs, "/f", "a");
      const t = tick(10);
      put(vfs, "/f", "b");
      const stat = vfs.stat("/f", true);
      expect(stat.mtimeMs).toBe(t);
      expect(stat.ctimeMs).toBe(t);
      expect(stat.birthtimeMs).toBe(1000);
    });

    it("updates only ctime on chmod", () => {
      const { vfs, tick } = setup();
      put(vfs, "/f", "a");
      const t = tick(10);
      vfs.chmod("/f", 0o600, true);
      const stat = vfs.stat("/f", true);
      expect(stat.ctimeMs).toBe(t);
      expect(stat.mtimeMs).toBe(1000);
      expect(stat.mode).toBe(S_IFREG | 0o600);
    });

    it("updates a directory's mtime and ctime when entries change", () => {
      const { vfs, tick } = setup();
      vfs.mkdir("/d", false, 0o777);
      let t = tick();
      put(vfs, "/d/f", "");
      expect(vfs.stat("/d", true).mtimeMs).toBe(t);
      t = tick();
      vfs.rename("/d/f", "/d/g");
      expect(vfs.stat("/d", true).ctimeMs).toBe(t);
      t = tick();
      vfs.unlink("/d/g");
      expect(vfs.stat("/d", true).mtimeMs).toBe(t);
    });

    it("sets atime and mtime with utimes and bumps ctime", () => {
      const { vfs, tick } = setup();
      put(vfs, "/f", "");
      const t = tick(5);
      vfs.utimes("/f", 111, 222, true);
      const stat = vfs.stat("/f", true);
      expect(stat.atimeMs).toBe(111);
      expect(stat.mtimeMs).toBe(222);
      expect(stat.ctimeMs).toBe(t);
    });

    it("sets a symlink's own times when not following", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      vfs.symlink("/f", "/link");
      vfs.utimes("/link", 1, 2, false);
      expect(vfs.stat("/link", false).mtimeMs).toBe(2);
      expect(vfs.stat("/f", true).mtimeMs).toBe(1000);
    });

    it("raises ENOENT for utimes on a missing path", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.utimes("/nope", 1, 2, true))).toMatchObject({
        code: "ENOENT",
        syscall: "utime",
        path: "/nope",
      });
    });
  });

  describe("directories", () => {
    it("creates and lists directories in name order", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      put(vfs, "/d/b", "");
      vfs.mkdir("/d/c", false, 0o777);
      vfs.symlink("b", "/d/a");
      expect(vfs.readdir("/d")).toEqual([
        { name: "a", type: "symlink" },
        { name: "b", type: "file" },
        { name: "c", type: "dir" },
      ]);
    });

    it("creates directories with mode 0755 after the umask", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      vfs.mkdir("/e", false, 0o700);
      expect(vfs.stat("/d", true).mode).toBe(S_IFDIR | 0o755);
      expect(vfs.stat("/e", true).mode).toBe(S_IFDIR | 0o700);
    });

    it("counts subdirectories in a directory's nlink", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      expect(vfs.stat("/d", true).nlink).toBe(2);
      vfs.mkdir("/d/a", false, 0o777);
      vfs.mkdir("/d/b", false, 0o777);
      expect(vfs.stat("/d", true).nlink).toBe(4);
      vfs.rmdir("/d/a");
      expect(vfs.stat("/d", true).nlink).toBe(3);
    });

    it("raises EEXIST for mkdir on an existing entry", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      expect(failure(() => vfs.mkdir("/d", false, 0o777))).toMatchObject({
        code: "EEXIST",
        syscall: "mkdir",
        path: "/d",
      });
      expect(failure(() => vfs.mkdir("/", false, 0o777))).toMatchObject({
        code: "EEXIST",
        syscall: "mkdir",
        path: "/",
      });
    });

    it("raises ENOENT for mkdir under a missing parent", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.mkdir("/a/b", false, 0o777))).toMatchObject({
        code: "ENOENT",
        syscall: "mkdir",
        path: "/a/b",
      });
    });

    it("returns the first directory mkdir -p created", () => {
      const { vfs } = setup();
      vfs.mkdir("/a", false, 0o777);
      expect(vfs.mkdir("/a/b/c/d", true, 0o777)).toBe("/a/b");
      expect(vfs.stat("/a/b/c/d", true).mode & S_IFMT).toBe(S_IFDIR);
    });

    it("returns undefined from mkdir -p when everything existed", () => {
      const { vfs } = setup();
      vfs.mkdir("/a/b", true, 0o777);
      expect(vfs.mkdir("/a/b", true, 0o777)).toBeUndefined();
      expect(vfs.mkdir("/", true, 0o777)).toBeUndefined();
    });

    it("follows symlinks in mkdir -p", () => {
      const { vfs } = setup();
      vfs.mkdir("/real", false, 0o777);
      vfs.symlink("/real", "/link");
      expect(vfs.mkdir("/link/x/y", true, 0o777)).toBe("/link/x");
      expect(vfs.exists("/real/x/y")).toBe(true);
    });

    it("raises ENOTDIR for mkdir -p through a file and EEXIST at a file", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(failure(() => vfs.mkdir("/f/x/y", true, 0o777))).toMatchObject({
        code: "ENOTDIR",
        syscall: "mkdir",
        path: "/f/x/y",
      });
      expect(failure(() => vfs.mkdir("/f", true, 0o777))).toMatchObject({
        code: "EEXIST",
        syscall: "mkdir",
        path: "/f",
      });
    });

    it("accepts a trailing slash in mkdir", () => {
      const { vfs } = setup();
      vfs.mkdir("/d/", false, 0o777);
      expect(vfs.mkdir("/e/f/", true, 0o777)).toBe("/e");
      expect(vfs.exists("/d")).toBe(true);
      expect(vfs.exists("/e/f")).toBe(true);
    });

    it("removes an empty directory with rmdir", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      vfs.rmdir("/d");
      expect(vfs.exists("/d")).toBe(false);
    });

    it("raises ENOTEMPTY for rmdir on a non-empty directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      put(vfs, "/d/f", "");
      expect(failure(() => vfs.rmdir("/d"))).toMatchObject({
        code: "ENOTEMPTY",
        syscall: "rmdir",
        path: "/d",
      });
    });

    it("raises ENOTDIR for rmdir on a file", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(failure(() => vfs.rmdir("/f"))).toMatchObject({
        code: "ENOTDIR",
        syscall: "rmdir",
        path: "/f",
      });
    });

    it("raises ENOENT and EBUSY for rmdir", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.rmdir("/nope"))).toMatchObject({
        code: "ENOENT",
        syscall: "rmdir",
        path: "/nope",
      });
      expect(failure(() => vfs.rmdir("/"))).toMatchObject({
        code: "EBUSY",
        syscall: "rmdir",
        path: "/",
      });
    });

    it("raises ENOTDIR for rmdir on a symlink to a directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      vfs.symlink("/d", "/link");
      expect(failure(() => vfs.rmdir("/link"))).toMatchObject({
        code: "ENOTDIR",
        syscall: "rmdir",
      });
    });

    it("raises ENOTDIR for readdir on a file and ENOENT on a missing path", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(failure(() => vfs.readdir("/f"))).toMatchObject({
        code: "ENOTDIR",
        syscall: "scandir",
        path: "/f",
      });
      expect(failure(() => vfs.readdir("/nope"))).toMatchObject({
        code: "ENOENT",
        syscall: "scandir",
        path: "/nope",
      });
    });

    it("reads a directory through a symlink", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      put(vfs, "/d/f", "");
      vfs.symlink("/d", "/link");
      expect(vfs.readdir("/link")).toEqual([{ name: "f", type: "file" }]);
    });
  });

  describe("Linux path rules", () => {
    it("O_TRUNC on an empty file sets its times and reports a change", () => {
      const { vfs, tick } = setup();
      put(vfs, "/e", "");
      vfs.utimes("/e", 1, 1, true);
      const events = watchAll(vfs, "/e", false);
      const t = tick();
      put(vfs, "/e", "");
      expect(vfs.stat("/e", true).mtimeMs).toBe(t);
      expect(vfs.stat("/e", true).ctimeMs).toBe(t);
      expect(events).toEqual([{ eventType: "change", path: "/e" }]);
    });

    it("mkdir -p does not create through a dangling symbolic link", () => {
      const { vfs } = setup();
      vfs.mkdir("/t", false, 0o777);
      vfs.symlink("/t/target", "/t/a");
      vfs.symlink("missing/x", "/t/deep");
      for (const path of ["/t/a/b", "/t/a", "/t/a/", "/t/deep", "/t/deep/c"]) {
        expect(failure(() => vfs.mkdir(path, true, 0o777))).toEqual({
          code: "EEXIST",
          syscall: "mkdir",
          path,
          dest: undefined,
        });
      }
      expect(vfs.readdir("/t").map((entry) => entry.name)).toEqual(["a", "deep"]);
      // A link to a directory is still followed.
      vfs.mkdir("/t/real", false, 0o777);
      vfs.symlink("real", "/t/ok");
      expect(vfs.mkdir("/t/ok/x/y", true, 0o777)).toBe("/t/ok/x");
      expect(vfs.stat("/t/real/x/y", true).mode & S_IFMT).toBe(S_IFDIR);
    });

    it("a trailing slash names a directory: rename of a file to `name/` is ENOTDIR", () => {
      const { vfs } = setup();
      put(vfs, "/f", "1");
      vfs.mkdir("/d", false, 0o777);
      vfs.symlink("/d", "/l");
      for (const target of ["/nf/", "/d/", "/nf//"]) {
        expect(failure(() => vfs.rename("/f", target))).toEqual({
          code: "ENOTDIR",
          syscall: "rename",
          path: "/f",
          dest: target,
        });
      }
      expect(failure(() => vfs.rename("/l", "/nl/"))).toMatchObject({ code: "ENOTDIR" });
      expect(vfs.exists("/f")).toBe(true);
      expect(vfs.exists("/nf")).toBe(false);
      vfs.rename("/d", "/nd/");
      expect(vfs.stat("/nd", true).mode & S_IFMT).toBe(S_IFDIR);
      expect(failure(() => vfs.unlink("/f/"))).toMatchObject({ code: "ENOTDIR" });
      expect(failure(() => vfs.open("/f/", O_RDONLY, 0))).toMatchObject({ code: "ENOTDIR" });
      expect(failure(() => vfs.open("/nf/", WRITE, 0o666))).toMatchObject({ code: "EISDIR" });
    });

    it("rmdir of a last part `.` is EINVAL and of `..` is ENOTEMPTY", () => {
      const { vfs } = setup();
      vfs.mkdir("/t5", false, 0o777);
      vfs.mkdir("/t6/a", true, 0o777);
      expect(failure(() => vfs.rmdir("/t5/."))).toMatchObject({ code: "EINVAL" });
      expect(failure(() => vfs.rmdir("/t5/./"))).toMatchObject({ code: "EINVAL" });
      expect(failure(() => vfs.rmdir("/t5/../t5/."))).toMatchObject({ code: "EINVAL" });
      expect(failure(() => vfs.rmdir("/t6/a/.."))).toMatchObject({ code: "ENOTEMPTY" });
      expect(failure(() => vfs.rmdir("/t5/.."))).toMatchObject({ code: "ENOTEMPTY" });
      expect(failure(() => vfs.rmdir("/nope/."))).toMatchObject({ code: "ENOENT" });
      expect(vfs.exists("/t5")).toBe(true);
      expect(vfs.exists("/t6/a")).toBe(true);
      vfs.rmdir("/t5/");
      expect(vfs.exists("/t5")).toBe(false);
    });
  });

  describe("unlink and rm", () => {
    it("removes a file with unlink", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      vfs.unlink("/f");
      expect(vfs.exists("/f")).toBe(false);
    });

    it("raises EISDIR for unlink on a directory and ENOENT for a missing file", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      expect(failure(() => vfs.unlink("/d"))).toMatchObject({
        code: "EISDIR",
        syscall: "unlink",
        path: "/d",
      });
      expect(failure(() => vfs.unlink("/nope"))).toMatchObject({
        code: "ENOENT",
        syscall: "unlink",
        path: "/nope",
      });
    });

    it("removes the link, not its target, on unlink of a symlink", () => {
      const { vfs } = setup();
      put(vfs, "/f", "x");
      vfs.symlink("/f", "/link");
      vfs.unlink("/link");
      expect(vfs.exists("/link")).toBe(false);
      expect(read(vfs, "/f")).toBe("x");
    });

    it("removes a file with rm", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      vfs.rm("/f", false, false);
      expect(vfs.exists("/f")).toBe(false);
    });

    it("raises ENOENT from rm unless force", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.rm("/nope", false, false))).toMatchObject({
        code: "ENOENT",
        syscall: "rm",
        path: "/nope",
      });
      vfs.rm("/nope", false, true);
      vfs.rm("/no/such/deep", true, true);
    });

    it("raises EISDIR from a non-recursive rm of a directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      expect(failure(() => vfs.rm("/d", false, false))).toMatchObject({
        code: "EISDIR",
        syscall: "rm",
        path: "/d",
      });
    });

    it("removes a tree with recursive rm and frees its inodes", () => {
      const { vfs } = setup();
      const before = vfs.totals();
      vfs.mkdir("/d/a/b", true, 0o777);
      put(vfs, "/d/a/b/f", "12345");
      put(vfs, "/d/g", "1");
      vfs.symlink("/d/g", "/d/a/link");
      vfs.rm("/d", true, false);
      expect(vfs.exists("/d")).toBe(false);
      expect(vfs.totals()).toEqual(before);
    });

    it("removes a symlink to a directory without touching the directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      put(vfs, "/d/f", "");
      vfs.symlink("/d", "/link");
      vfs.rm("/link", true, false);
      expect(vfs.exists("/d/f")).toBe(true);
    });

    it("raises EBUSY for rm of the root", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.rm("/", true, true))).toMatchObject({
        code: "EBUSY",
        syscall: "rm",
        path: "/",
      });
    });
  });

  describe("rename", () => {
    it("moves a file", () => {
      const { vfs } = setup();
      put(vfs, "/a", "x");
      vfs.mkdir("/d", false, 0o777);
      vfs.rename("/a", "/d/b");
      expect(vfs.exists("/a")).toBe(false);
      expect(read(vfs, "/d/b")).toBe("x");
    });

    it("replaces an existing file atomically", () => {
      const { vfs } = setup();
      put(vfs, "/a", "new");
      put(vfs, "/b", "old");
      const before = vfs.totals().inodes;
      vfs.rename("/a", "/b");
      expect(read(vfs, "/b")).toBe("new");
      expect(vfs.exists("/a")).toBe(false);
      expect(vfs.totals().inodes).toBe(before - 1);
    });

    it("moves a directory with its contents", () => {
      const { vfs } = setup();
      vfs.mkdir("/a/b", true, 0o777);
      put(vfs, "/a/b/f", "x");
      vfs.rename("/a", "/z");
      expect(read(vfs, "/z/b/f")).toBe("x");
      expect(vfs.realpath("/z/b/f")).toBe("/z/b/f");
    });

    it("replaces an empty directory with a directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/a", false, 0o777);
      put(vfs, "/a/f", "");
      vfs.mkdir("/b", false, 0o777);
      vfs.rename("/a", "/b");
      expect(vfs.exists("/b/f")).toBe(true);
    });

    it("raises ENOTEMPTY replacing a non-empty directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/a", false, 0o777);
      vfs.mkdir("/b", false, 0o777);
      put(vfs, "/b/f", "");
      expect(failure(() => vfs.rename("/a", "/b"))).toMatchObject({
        code: "ENOTEMPTY",
        syscall: "rename",
        path: "/a",
        dest: "/b",
      });
    });

    it("raises EISDIR moving a file over a directory", () => {
      const { vfs } = setup();
      put(vfs, "/a", "");
      vfs.mkdir("/b", false, 0o777);
      expect(failure(() => vfs.rename("/a", "/b"))).toMatchObject({
        code: "EISDIR",
        syscall: "rename",
        path: "/a",
        dest: "/b",
      });
    });

    it("raises ENOTDIR moving a directory over a file", () => {
      const { vfs } = setup();
      vfs.mkdir("/a", false, 0o777);
      put(vfs, "/b", "");
      expect(failure(() => vfs.rename("/a", "/b"))).toMatchObject({
        code: "ENOTDIR",
        syscall: "rename",
        path: "/a",
        dest: "/b",
      });
    });

    it("raises EINVAL moving a directory into its own subtree", () => {
      const { vfs } = setup();
      vfs.mkdir("/a/b", true, 0o777);
      expect(failure(() => vfs.rename("/a", "/a/b/c"))).toMatchObject({
        code: "EINVAL",
        syscall: "rename",
        path: "/a",
        dest: "/a/b/c",
      });
      expect(failure(() => vfs.rename("/a", "/a/c"))).toMatchObject({ code: "EINVAL" });
    });

    it("raises ENOENT for a missing source or target parent", () => {
      const { vfs } = setup();
      put(vfs, "/a", "");
      expect(failure(() => vfs.rename("/nope", "/b"))).toMatchObject({
        code: "ENOENT",
        syscall: "rename",
        path: "/nope",
        dest: "/b",
      });
      expect(failure(() => vfs.rename("/a", "/no/b"))).toMatchObject({
        code: "ENOENT",
        syscall: "rename",
        path: "/a",
        dest: "/no/b",
      });
    });

    it("does nothing renaming onto itself or a hard link of itself", () => {
      const { vfs } = setup();
      put(vfs, "/a", "x");
      vfs.rename("/a", "/a");
      vfs.link("/a", "/b");
      vfs.rename("/a", "/b");
      expect(read(vfs, "/a")).toBe("x");
      expect(read(vfs, "/b")).toBe("x");
    });

    it("moves a symlink itself, not its target", () => {
      const { vfs } = setup();
      put(vfs, "/f", "x");
      vfs.symlink("/f", "/link");
      vfs.rename("/link", "/moved");
      expect(vfs.readlink("/moved")).toBe("/f");
      expect(vfs.exists("/f")).toBe(true);
    });

    it("updates nlink of both parents when moving a directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/a/sub", true, 0o777);
      vfs.mkdir("/b", false, 0o777);
      vfs.rename("/a/sub", "/b/sub");
      expect(vfs.stat("/a", true).nlink).toBe(2);
      expect(vfs.stat("/b", true).nlink).toBe(3);
    });

    it("raises EBUSY renaming the root", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.rename("/", "/x"))).toMatchObject({
        code: "EBUSY",
        syscall: "rename",
      });
    });
  });

  describe("hard links", () => {
    it("shares data and counts links", () => {
      const { vfs } = setup();
      put(vfs, "/a", "x");
      vfs.link("/a", "/b");
      expect(vfs.stat("/a", true).nlink).toBe(2);
      expect(vfs.stat("/b", true).ino).toBe(vfs.stat("/a", true).ino);
      put(vfs, "/b", "changed");
      expect(read(vfs, "/a")).toBe("changed");
      vfs.unlink("/a");
      expect(vfs.stat("/b", true).nlink).toBe(1);
      expect(read(vfs, "/b")).toBe("changed");
    });

    it("raises EPERM linking a directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      expect(failure(() => vfs.link("/d", "/e"))).toMatchObject({
        code: "EPERM",
        syscall: "link",
        path: "/d",
        dest: "/e",
      });
    });

    it("raises EEXIST and ENOENT for link", () => {
      const { vfs } = setup();
      put(vfs, "/a", "");
      put(vfs, "/b", "");
      expect(failure(() => vfs.link("/a", "/b"))).toMatchObject({
        code: "EEXIST",
        syscall: "link",
        path: "/a",
        dest: "/b",
      });
      expect(failure(() => vfs.link("/nope", "/c"))).toMatchObject({
        code: "ENOENT",
        syscall: "link",
        path: "/nope",
        dest: "/c",
      });
    });

    it("links the symlink itself, not its target", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      vfs.symlink("/f", "/link");
      vfs.link("/link", "/link2");
      expect(vfs.readlink("/link2")).toBe("/f");
    });
  });

  describe("symbolic links", () => {
    it("follows absolute and relative targets", () => {
      const { vfs } = setup();
      vfs.mkdir("/d/sub", true, 0o777);
      put(vfs, "/d/sub/f", "x");
      vfs.symlink("/d/sub/f", "/abs");
      vfs.symlink("sub/f", "/d/rel");
      vfs.symlink("../sub", "/d/sub/up");
      expect(read(vfs, "/abs")).toBe("x");
      expect(read(vfs, "/d/rel")).toBe("x");
      expect(read(vfs, "/d/sub/up/f")).toBe("x");
    });

    it("reports the link or its target by followSymlinks", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abc");
      vfs.symlink("/f", "/link");
      const linkStat = vfs.stat("/link", false);
      expect(linkStat.mode).toBe(S_IFLNK | 0o777);
      expect(linkStat.size).toBe(2);
      expect(vfs.stat("/link", true).mode & S_IFMT).toBe(S_IFREG);
    });

    it("follows chains of links", () => {
      const { vfs } = setup();
      put(vfs, "/f", "x");
      vfs.symlink("/f", "/l1");
      vfs.symlink("/l1", "/l2");
      vfs.symlink("l2", "/l3");
      expect(read(vfs, "/l3")).toBe("x");
      expect(vfs.realpath("/l3")).toBe("/f");
    });

    it("raises ELOOP for a loop", () => {
      const { vfs } = setup();
      vfs.symlink("/b", "/a");
      vfs.symlink("/a", "/b");
      expect(failure(() => vfs.stat("/a", true))).toMatchObject({
        code: "ELOOP",
        syscall: "stat",
        path: "/a",
      });
      expect(failure(() => vfs.readFile("/a/x"))).toMatchObject({ code: "ELOOP", syscall: "open" });
      expect(vfs.stat("/a", false).mode & S_IFMT).toBe(S_IFLNK);
    });

    it("allows exactly 40 links and raises ELOOP at 41", () => {
      const { vfs } = setup();
      put(vfs, "/f", "x");
      vfs.symlink("/f", "/l0");
      for (let i = 1; i <= 40; i++) {
        vfs.symlink(`/l${i - 1}`, `/l${i}`);
      }
      expect(read(vfs, "/l39")).toBe("x");
      expect(failure(() => vfs.readFile("/l40"))).toMatchObject({ code: "ELOOP" });
    });

    it("reports ENOENT for a dangling link but lstat works", () => {
      const { vfs } = setup();
      vfs.symlink("/nowhere", "/link");
      expect(failure(() => vfs.stat("/link", true))).toMatchObject({
        code: "ENOENT",
        syscall: "stat",
        path: "/link",
      });
      expect(vfs.exists("/link")).toBe(false);
      expect(vfs.stat("/link", false).mode & S_IFMT).toBe(S_IFLNK);
    });

    it("follows a link in a middle component even when not following the last", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      vfs.symlink("/d", "/link");
      vfs.symlink("x", "/d/inner");
      expect(vfs.stat("/link/inner", false).mode & S_IFMT).toBe(S_IFLNK);
    });

    it("follows a final link when the path has a trailing slash", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      vfs.symlink("/d", "/link");
      expect(vfs.stat("/link/", false).mode & S_IFMT).toBe(S_IFDIR);
    });

    it("resolves .. after the link, physically", () => {
      const { vfs } = setup();
      vfs.mkdir("/x/y", true, 0o777);
      put(vfs, "/x/marker", "m");
      vfs.symlink("/x/y", "/link");
      expect(read(vfs, "/link/../marker")).toBe("m");
    });

    it("raises EEXIST creating a symlink over an entry", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(failure(() => vfs.symlink("/t", "/f"))).toMatchObject({
        code: "EEXIST",
        syscall: "symlink",
        path: "/t",
        dest: "/f",
      });
    });

    it("reads the stored target verbatim", () => {
      const { vfs } = setup();
      vfs.symlink("../some/./where", "/link");
      expect(vfs.readlink("/link")).toBe("../some/./where");
    });

    it("raises EINVAL for readlink on a non-link and ENOENT on a missing path", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(failure(() => vfs.readlink("/f"))).toMatchObject({
        code: "EINVAL",
        syscall: "readlink",
        path: "/f",
      });
      expect(failure(() => vfs.readlink("/nope"))).toMatchObject({
        code: "ENOENT",
        syscall: "readlink",
        path: "/nope",
      });
    });

    it("follows links on chmod when asked and refuses a link's own mode", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      vfs.symlink("/f", "/link");
      vfs.chmod("/link", 0o700, true);
      expect(vfs.stat("/f", true).mode).toBe(S_IFREG | 0o700);
      expect(failure(() => vfs.chmod("/link", 0o700, false))).toMatchObject({
        code: "ENOTSUP",
        syscall: "chmod",
      });
    });
  });

  describe("realpath", () => {
    it("resolves links, dots and slashes", () => {
      const { vfs } = setup();
      vfs.mkdir("/a/b", true, 0o777);
      vfs.symlink("/a", "/link");
      expect(vfs.realpath("/link/./b/../b//")).toBe("/a/b");
      expect(vfs.realpath("/")).toBe("/");
      expect(vfs.realpath("/a/..")).toBe("/");
    });

    it("raises ENOENT for a missing path", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.realpath("/nope"))).toMatchObject({
        code: "ENOENT",
        syscall: "realpath",
        path: "/nope",
      });
    });
  });

  describe("truncate", () => {
    it("shrinks and grows a file", () => {
      const { vfs } = setup();
      put(vfs, "/f", "abcdef");
      vfs.truncate("/f", 3);
      expect(read(vfs, "/f")).toBe("abc");
      vfs.truncate("/f", 5);
      expect(Array.from(vfs.readFile("/f"))).toEqual([97, 98, 99, 0, 0]);
      expect(vfs.totals().bytes).toBe(5);
    });

    it("raises ENOENT, EISDIR and EINVAL", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      put(vfs, "/f", "");
      expect(failure(() => vfs.truncate("/nope", 0))).toMatchObject({
        code: "ENOENT",
        path: "/nope",
      });
      expect(failure(() => vfs.truncate("/d", 0))).toMatchObject({ code: "EISDIR" });
      expect(failure(() => vfs.truncate("/f", -1))).toMatchObject({ code: "EINVAL" });
    });
  });

  describe("copyFile", () => {
    it("copies data and mode", () => {
      const { vfs } = setup();
      vfs.writeFile("/a", bytes("data"), WRITE, 0o755);
      vfs.copyFile("/a", "/b", 0);
      expect(read(vfs, "/b")).toBe("data");
      expect(vfs.stat("/b", true).mode).toBe(S_IFREG | 0o755);
      expect(vfs.stat("/b", true).ino).not.toBe(vfs.stat("/a", true).ino);
    });

    it("overwrites an existing file unless COPYFILE_EXCL", () => {
      const { vfs } = setup();
      put(vfs, "/a", "new");
      put(vfs, "/b", "older and longer");
      vfs.copyFile("/a", "/b", 0);
      expect(read(vfs, "/b")).toBe("new");
      expect(failure(() => vfs.copyFile("/a", "/b", COPYFILE_EXCL))).toMatchObject({
        code: "EEXIST",
        syscall: "copyfile",
        path: "/a",
        dest: "/b",
      });
    });

    it("raises ENOENT for a missing source and EISDIR for directories", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      put(vfs, "/a", "");
      expect(failure(() => vfs.copyFile("/nope", "/b", 0))).toMatchObject({
        code: "ENOENT",
        syscall: "copyfile",
        path: "/nope",
        dest: "/b",
      });
      expect(failure(() => vfs.copyFile("/d", "/b", 0))).toMatchObject({
        code: "EISDIR",
        syscall: "copyfile",
      });
      expect(failure(() => vfs.copyFile("/a", "/d", 0))).toMatchObject({
        code: "EISDIR",
        syscall: "copyfile",
      });
    });

    it("follows a source symlink", () => {
      const { vfs } = setup();
      put(vfs, "/a", "x");
      vfs.symlink("/a", "/link");
      vfs.copyFile("/link", "/b", 0);
      expect(vfs.stat("/b", false).mode & S_IFMT).toBe(S_IFREG);
    });

    it("does nothing copying a file onto itself", () => {
      const { vfs } = setup();
      put(vfs, "/a", "x");
      vfs.copyFile("/a", "/a", 0);
      expect(read(vfs, "/a")).toBe("x");
    });
  });

  describe("access", () => {
    it("passes for existing paths and raises ENOENT otherwise", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      vfs.access("/f", F_OK);
      vfs.access("/f", R_OK);
      expect(failure(() => vfs.access("/nope", F_OK))).toMatchObject({
        code: "ENOENT",
        syscall: "access",
        path: "/nope",
      });
    });

    it("raises EACCES for X_OK on a file with no execute bit", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      expect(failure(() => vfs.access("/f", X_OK))).toMatchObject({
        code: "EACCES",
        syscall: "access",
        path: "/f",
      });
      vfs.chmod("/f", 0o755, true);
      vfs.access("/f", X_OK);
      vfs.mkdir("/d", false, 0o777);
      vfs.access("/d", X_OK);
    });
  });

  describe("mkdtemp", () => {
    it("creates unique directories with six random characters", () => {
      const { vfs } = setup();
      vfs.mkdir("/tmp", false, 0o777);
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const path = vfs.mkdtemp("/tmp/x-");
        expect(path).toMatch(/^\/tmp\/x-[A-Za-z0-9]{6}$/);
        expect(vfs.stat(path, true).mode).toBe(S_IFDIR | 0o700);
        seen.add(path);
      }
      expect(seen.size).toBe(200);
    });

    it("raises ENOENT under a missing parent", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.mkdtemp("/nope/x-"))).toMatchObject({
        code: "ENOENT",
        syscall: "mkdtemp",
        path: "/nope/x-XXXXXX",
      });
    });
  });

  describe("watch", () => {
    it("reports create, write and delete in a watched directory", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      const events = watchAll(vfs, "/d", false);
      put(vfs, "/d/f", "x");
      vfs.unlink("/d/f");
      expect(events).toEqual([
        { eventType: "rename", path: "/d/f" },
        { eventType: "change", path: "/d/f" },
        { eventType: "rename", path: "/d/f" },
      ]);
    });

    it("does not report nested entries without recursive", () => {
      const { vfs } = setup();
      vfs.mkdir("/d/sub", true, 0o777);
      const events = watchAll(vfs, "/d", false);
      put(vfs, "/d/sub/f", "x");
      put(vfs, "/other", "x");
      expect(events).toEqual([]);
    });

    it("reports nested entries with recursive", () => {
      const { vfs } = setup();
      vfs.mkdir("/d/sub", true, 0o777);
      const events = watchAll(vfs, "/d", true);
      put(vfs, "/d/sub/f", "");
      vfs.mkdir("/d/sub/deeper", false, 0o777);
      expect(events).toEqual([
        { eventType: "rename", path: "/d/sub/f" },
        { eventType: "rename", path: "/d/sub/deeper" },
      ]);
    });

    it("does not match a sibling that shares the prefix", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      vfs.mkdir("/dd", false, 0o777);
      const events = watchAll(vfs, "/d", true);
      put(vfs, "/dd/f", "");
      expect(events).toEqual([]);
    });

    it("reports both sides of a rename", () => {
      const { vfs } = setup();
      vfs.mkdir("/d", false, 0o777);
      put(vfs, "/d/a", "");
      const events = watchAll(vfs, "/d", false);
      vfs.rename("/d/a", "/d/b");
      expect(events).toEqual([
        { eventType: "rename", path: "/d/a" },
        { eventType: "rename", path: "/d/b" },
      ]);
    });

    it("watches a single file for writes, chmod, utimes and truncate", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      put(vfs, "/g", "");
      const events = watchAll(vfs, "/f", false);
      put(vfs, "/f", "x");
      vfs.chmod("/f", 0o600, true);
      vfs.utimes("/f", 1, 2, true);
      vfs.truncate("/f", 0);
      put(vfs, "/g", "x");
      // The first write's O_TRUNC reports too, though /f was empty (as Linux).
      expect(events.map((event) => event.eventType)).toEqual([
        "change",
        "change",
        "change",
        "change",
        "change",
      ]);
      expect(new Set(events.map((event) => event.path))).toEqual(new Set(["/f"]));
    });

    it("reports writes through an open file", () => {
      const { vfs } = setup();
      put(vfs, "/f", "");
      const events = watchAll(vfs, "/f", false);
      const file = vfs.open("/f", O_WRONLY, 0);
      file.write(bytes("abc"), null);
      file.close();
      expect(events).toEqual([{ eventType: "change", path: "/f" }]);
    });

    it("reports each removed entry of a recursive rm", () => {
      const { vfs } = setup();
      vfs.mkdir("/d/a", true, 0o777);
      put(vfs, "/d/a/f", "");
      const events = watchAll(vfs, "/", true);
      vfs.rm("/d", true, false);
      expect(events.map((event) => event.path)).toEqual(["/d/a/f", "/d/a", "/d"]);
    });

    it("stops after unsubscribe", () => {
      const { vfs } = setup();
      const events: VfsWatchEvent[] = [];
      const stop = vfs.watch("/", false, (event) => events.push(event));
      put(vfs, "/a", "");
      stop();
      stop();
      put(vfs, "/b", "");
      expect(events.map((event) => event.path)).toEqual(["/a"]);
    });

    it("is safe to unsubscribe another listener during dispatch", () => {
      const { vfs } = setup();
      const calls: string[] = [];
      let stopSecond: () => void = () => {};
      vfs.watch("/", false, () => {
        calls.push("first");
        stopSecond();
      });
      stopSecond = vfs.watch("/", false, () => calls.push("second"));
      vfs.mkdir("/x", false, 0o777);
      expect(calls).toEqual(["first"]);
    });

    it("keeps going when a listener throws", () => {
      const { vfs } = setup();
      const events: VfsWatchEvent[] = [];
      vfs.watch("/", false, () => {
        throw new Error("listener bug");
      });
      vfs.watch("/", false, (event) => events.push(event));
      vfs.mkdir("/x", false, 0o777);
      expect(vfs.exists("/x")).toBe(true);
      expect(events).toEqual([{ eventType: "rename", path: "/x" }]);
    });

    it("watches through a symlinked path at its real location", () => {
      const { vfs } = setup();
      vfs.mkdir("/real", false, 0o777);
      vfs.symlink("/real", "/link");
      const events = watchAll(vfs, "/link", false);
      put(vfs, "/real/f", "");
      expect(events[0]).toEqual({ eventType: "rename", path: "/real/f" });
    });

    it("raises ENOENT watching a missing path", () => {
      const { vfs } = setup();
      expect(failure(() => vfs.watch("/nope", false, () => {}))).toMatchObject({
        code: "ENOENT",
        syscall: "watch",
        path: "/nope",
      });
    });
  });

  describe("totals", () => {
    it("counts inodes and bytes", () => {
      const { vfs } = setup();
      expect(vfs.totals()).toEqual({ inodes: 1, bytes: 0 });
      put(vfs, "/a", "12345");
      vfs.mkdir("/d", false, 0o777);
      vfs.symlink("/a", "/l");
      expect(vfs.totals()).toEqual({ inodes: 4, bytes: 5 });
      vfs.unlink("/a");
      expect(vfs.totals()).toEqual({ inodes: 3, bytes: 0 });
    });
  });

  describe("scale", () => {
    it("handles 100k small files within a time budget", () => {
      const { vfs } = setup();
      const start = performance.now();
      const data = bytes("module.exports = 1;\n");
      for (let d = 0; d < 100; d++) {
        vfs.mkdir(`/node_modules/pkg${d}/lib`, true, 0o777);
        for (let f = 0; f < 1000; f++) {
          vfs.writeFile(`/node_modules/pkg${d}/lib/file${f}.js`, data, WRITE, 0o644);
        }
      }
      for (let d = 0; d < 100; d++) {
        expect(vfs.exists(`/node_modules/pkg${d}/lib/file999.js`)).toBe(true);
        expect(vfs.readdir(`/node_modules/pkg${d}/lib`).length).toBe(1000);
      }
      const elapsed = performance.now() - start;
      expect(vfs.totals().inodes).toBe(1 + 1 + 200 + 100_000);
      expect(elapsed).toBeLessThan(3000);
      vfs.rm("/node_modules", true, false);
      expect(vfs.totals()).toEqual({ inodes: 1, bytes: 0 });
    });
  });
});

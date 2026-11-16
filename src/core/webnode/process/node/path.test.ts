// @vitest-environment node
// Differential tests: path.posix and path.win32 against Node's own `path`.
import nodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setRuntime, type ProcessRuntime } from "../runtime";
import path, { posix, win32 } from "./path";

/** The thrown error's comparable parts, or the value returned. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    const e = error as { code?: string; name?: string; message?: string };
    return { error: { code: e.code, name: e.name, message: e.message } };
  }
}

const inputs = [
  "",
  ".",
  "..",
  "/",
  "//",
  "///",
  "a",
  "a/",
  "a//",
  "/a",
  "/a/",
  "/a/b",
  "/a/b/",
  "/a//b",
  "a/b/c",
  "a/./b",
  "a/../b",
  "../a",
  "../../a/b",
  "./a",
  "./",
  "/..",
  "/../a",
  "/a/../..",
  "a/../../b",
  "a/b/../../..",
  "/foo/bar/baz/asdf/quux/..",
  "foo.txt",
  ".bashrc",
  ".bashrc.txt",
  "file.",
  "file..",
  "file.tar.gz",
  "/dir.d/file",
  "/dir/.file",
  "/dir/..file",
  "..file",
  "...",
  ".../",
  "a/.../b",
  "/a/b.c/",
  "/a/b.c//",
  "a\\b",
  "\\a\\b",
  "\\\\server\\share",
  "\\\\server\\share\\",
  "\\\\server\\share\\dir\\file.txt",
  "//server/share",
  "//server/share/dir",
  "\\\\?\\C:\\foo",
  "\\\\.\\PHYSICALDRIVE0",
  "\\\\.\\pipe\\name",
  "\\\\?\\COM1:",
  "C:",
  "C:\\",
  "C:/",
  "C:\\foo",
  "C:foo",
  "C:foo\\bar",
  "C:\\foo\\bar\\",
  "C:\\foo\\..\\..\\bar",
  "c:/ignore",
  "d:\\a/b\\c/d",
  "c:\\foo\\bar.txt",
  "C:\\.foo",
  "C:\\foo.",
  "CON:",
  "COM1:file",
  "lpt1:",
  "foo:bar",
  "foo:",
  "a:b:c",
  "file:stream",
  "./c:/foo",
  "x/../c:",
  "\\",
  "\\\\",
  "\\\\\\",
  "/foo/bar//baz/asdf/quux/..",
  "a/b/c/../../../x/y",
  "日本/語.txt",
  " /space ",
  "/a/b/c/.",
];

const twoArg = [
  ["/var/lib", "../", "file/"],
  ["/foo/bar", "./baz"],
  ["/foo/bar", "/tmp/file/"],
  ["wwwroot", "static_files/png/", "../gif/image.gif"],
  ["/a", "b", "c"],
  ["a", "", "b"],
  ["", ""],
  ["/", ".."],
  ["c:/", "//"],
  ["c:/ignore", "d:\\a/b\\c/d", "\\e.exe"],
  ["c:/ignore", "c:/some/file"],
  ["d:/ignore", "d:some/dir//"],
  ["//server/share", "..", "relative\\"],
  ["c:/", "//dir"],
  ["C:\\foo", "\\\\server\\share"],
  ["//", "a"],
  ["\\\\", "\\a"],
  ["a", "//b"],
  ["/", "/"],
];

const relativePairs = [
  ["/var/lib", "/var"],
  ["/var/lib", "/bin"],
  ["/var/lib", "/var/lib"],
  ["/var/lib", "/var/apache"],
  ["/var/", "/var/lib"],
  ["/", "/var/lib"],
  ["/foo/test", "/foo/test/bar/package.json"],
  ["/Users/a/web/b/test/mails", "/Users/a/web/b"],
  ["/foo/bar/baz-quux", "/foo/bar/baz"],
  ["/foo/bar/baz", "/foo/bar/baz-quux"],
  ["/baz-quux", "/baz"],
  ["/baz", "/baz-quux"],
  ["/page1/page2/foo", "/"],
  ["a/b", "a/c"],
  ["", "/a"],
  ["c:/blah\\blah", "d:/games"],
  ["c:/aaaa/bbbb", "c:/aaaa"],
  ["c:/aaaa/bbbb", "c:/cccc"],
  ["c:/aaaa/bbbb", "c:/aaaa/bbbb"],
  ["c:/aaaa/", "c:/aaaa/cccc"],
  ["c:/", "c:\\aaaa\\bbbb"],
  ["c:/aaaa/bbbb", "d:\\"],
  ["c:/AaAa/bbbb", "c:/aaaa/bbbb"],
  ["c:/aaaaa/", "c:/aaaa/cccc"],
  ["C:\\foo\\bar\\baz\\quux", "C:\\"],
  ["C:\\foo\\test", "C:\\foo\\test\\bar\\package.json"],
  ["C:\\foo\\bar\\baz-quux", "C:\\foo\\bar\\baz"],
  ["\\\\foo\\bar", "\\\\foo\\bar\\baz"],
  ["\\\\foo\\bar\\baz", "\\\\foo\\bar"],
  ["\\\\foo\\bar\\baz-quux", "\\\\foo\\bar\\baz"],
  ["C:\\baz-quux", "C:\\baz"],
  ["C:\\baz", "\\\\foo\\bar\\baz"],
  ["\\\\foo\\baz", "C:\\baz"],
  ["C:\\İ", "C:\\i"],
  ["C:\\ÄÖÜ\\x", "C:\\äöü\\y"],
];

describe.each([
  ["posix", posix, nodePath.posix],
  ["win32", win32, nodePath.win32],
] as const)("path.%s matches Node", (_name, ours, theirs) => {
  beforeAll(() => {
    setRuntime({ cwd: process.cwd(), env: {} } as unknown as ProcessRuntime);
  });
  afterAll(() => {
    setRuntime(null);
  });

  it.each(inputs)("single-argument functions of %j", (input) => {
    expect(ours.normalize(input)).toBe(theirs.normalize(input));
    expect(ours.isAbsolute(input)).toBe(theirs.isAbsolute(input));
    expect(ours.dirname(input)).toBe(theirs.dirname(input));
    expect(ours.basename(input)).toBe(theirs.basename(input));
    expect(ours.extname(input)).toBe(theirs.extname(input));
    expect(ours.parse(input)).toEqual(theirs.parse(input));
    expect(ours.format(ours.parse(input))).toBe(theirs.format(theirs.parse(input)));
    expect(ours.resolve(input)).toBe(theirs.resolve(input));
    expect(ours.toNamespacedPath(input)).toBe(theirs.toNamespacedPath(input));
    expect(ours.join(input)).toBe(theirs.join(input));
    expect(ours.join(input, input)).toBe(theirs.join(input, input));
    expect(ours.join("a", input, "b")).toBe(theirs.join("a", input, "b"));
    for (const suffix of [".txt", "t", "", "b", "file", input]) {
      expect(ours.basename(input, suffix)).toBe(theirs.basename(input, suffix));
    }
  });

  it.each(twoArg)("join and resolve of %j", (...args) => {
    expect(ours.join(...args)).toBe(theirs.join(...args));
    expect(ours.resolve(...args)).toBe(theirs.resolve(...args));
  });

  it.each(relativePairs)("relative(%j, %j)", (from, to) => {
    expect(ours.relative(from, to)).toBe(theirs.relative(from, to));
    expect(ours.relative(to, from)).toBe(theirs.relative(to, from));
  });

  it("resolves with no arguments to the working directory", () => {
    expect(ours.resolve()).toBe(theirs.resolve());
    expect(ours.resolve("")).toBe(theirs.resolve(""));
    expect(ours.resolve(".")).toBe(theirs.resolve("."));
  });

  it("formats path objects as Node does", () => {
    const objects = [
      { root: "/", dir: "/home/user/dir", base: "file.txt" },
      { root: "/", base: "file.txt", ext: "ignored" },
      { root: "/", name: "file", ext: ".txt" },
      { root: "/", name: "file", ext: "txt" },
      { name: "x" },
      { dir: "d", name: "n", ext: "e" },
      { root: "C:\\", dir: "C:\\path\\dir", base: "file.txt" },
      {},
    ];
    for (const object of objects) {
      expect(ours.format(object)).toBe(theirs.format(object));
    }
  });

  it("validates arguments with Node's errors", () => {
    const bad: unknown[] = [null, undefined, 1, true, {}, [], () => {}];
    for (const value of bad) {
      for (const call of [
        (p: typeof ours | typeof theirs) => p.normalize(value as string),
        (p: typeof ours | typeof theirs) => p.join("a", value as string),
        (p: typeof ours | typeof theirs) => p.resolve("a", value as string),
        (p: typeof ours | typeof theirs) => p.basename(value as string),
        (p: typeof ours | typeof theirs) => p.basename("a", value as string),
        (p: typeof ours | typeof theirs) => p.relative(value as string, "a"),
        (p: typeof ours | typeof theirs) => p.dirname(value as string),
        (p: typeof ours | typeof theirs) => p.extname(value as string),
        (p: typeof ours | typeof theirs) => p.parse(value as string),
        (p: typeof ours | typeof theirs) => p.isAbsolute(value as string),
      ]) {
        expect(outcome(() => call(ours))).toEqual(outcome(() => call(theirs)));
      }
    }
    expect(() => ours.format(null as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("passes non-strings through toNamespacedPath", () => {
    expect(ours.toNamespacedPath(null as never)).toBe(theirs.toNamespacedPath(null as never));
  });
});

describe("path module shape", () => {
  it("defaults to posix with cross links", () => {
    expect(path).toBe(posix);
    expect(path.posix).toBe(posix);
    expect(path.win32).toBe(win32);
    expect(win32.posix).toBe(posix);
    expect(win32.win32).toBe(win32);
    expect(posix.sep).toBe("/");
    expect(posix.delimiter).toBe(":");
    expect(win32.sep).toBe("\\");
    expect(win32.delimiter).toBe(";");
    expect(posix._makeLong).toBe(posix.toNamespacedPath);
    expect(Object.keys(posix).sort()).toEqual(Object.keys(nodePath.posix).sort());
  });

  it("names matchesGlob as unsupported", () => {
    expect(() => posix.matchesGlob("a", "*")).toThrow(/matchesGlob/);
  });

  it("resolves against / without a runtime", () => {
    setRuntime(null);
    expect(posix.resolve("a/b")).toBe("/a/b");
    expect(posix.resolve()).toBe("/");
  });

  it("resolves against the runtime's cwd", () => {
    setRuntime({ cwd: "/home/project", env: {} } as unknown as ProcessRuntime);
    expect(posix.resolve("src")).toBe("/home/project/src");
    expect(posix.relative("/home/project/src/a.ts", "/home/project/lib")).toBe("../../lib");
    setRuntime(null);
  });
});

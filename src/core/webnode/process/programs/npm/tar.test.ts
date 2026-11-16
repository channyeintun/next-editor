// @vitest-environment node
import { describe, expect, it } from "vitest";
import { gunzip, parseTar, stripPath } from "./tar";
import { gzip, writeTar } from "./testkit";

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const longPath = `package/${"deep/".repeat(30)}file.js`;

describe("parseTar", () => {
  it("reads files and directories and strips the first component", () => {
    const entries = parseTar(
      writeTar([
        { path: "package/", type: "5" },
        { path: "package/lib", type: "5" },
        { path: "package/lib/index.js", data: "module.exports = 1;" },
        { path: "package/package.json", data: "{}" },
      ]),
    );
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["lib", "directory"],
      ["lib/index.js", "file"],
      ["package.json", "file"],
    ]);
    expect(text(entries[1].data)).toBe("module.exports = 1;");
  });

  it("keeps execute bits in the mode", () => {
    const [entry] = parseTar(
      writeTar([{ path: "package/bin/cli.js", data: "#!/usr/bin/env node", mode: 0o755 }]),
    );
    expect(entry.mode & 0o111).toBe(0o111);
  });

  it("reads long names from pax headers", () => {
    const [entry] = parseTar(writeTar([{ path: longPath, data: "x", longName: "pax" }]));
    expect(entry.path).toBe(longPath.slice("package/".length));
  });

  it("reads GNU long names", () => {
    const [entry] = parseTar(writeTar([{ path: longPath, data: "x", longName: "gnu" }]));
    expect(entry.path).toBe(longPath.slice("package/".length));
  });

  it("joins the ustar prefix field", () => {
    const [entry] = parseTar(writeTar([{ path: longPath, data: "x", longName: "prefix" }]));
    expect(entry.path).toBe(longPath.slice("package/".length));
  });

  it("skips link entries", () => {
    const entries = parseTar(
      writeTar([
        { path: "package/link", type: "2" },
        { path: "package/a.js", data: "a" },
      ]),
    );
    expect(entries.map((entry) => entry.path)).toEqual(["a.js"]);
  });

  it("refuses paths that escape the package", () => {
    expect(() => parseTar(writeTar([{ path: "package/../../etc/passwd", data: "x" }]))).toThrow(
      /escapes/,
    );
    expect(stripPath("package/a/../b.js")).toBe("b.js");
    expect(stripPath("package/./a//b.js")).toBe("a/b.js");
    expect(stripPath("package/")).toBeNull();
  });

  it("rejects a negative or non-numeric pax size instead of looping", () => {
    for (const size of ["-1536", "-1", "abc", "1.5"]) {
      const tar = writeTar([{ path: "package/a.js", data: "a", pax: { size } }]);
      expect(() => parseTar(tar)).toThrow(/Invalid tar entry size/);
    }
  });

  it("rejects a truncated archive", () => {
    const tar = writeTar([{ path: "package/a.js", data: "x".repeat(2000) }]);
    expect(() => parseTar(tar.subarray(0, 1024))).toThrow(/Truncated/);
  });
});

describe("gunzip", () => {
  it("round-trips through DecompressionStream", async () => {
    const tar = writeTar([{ path: "package/a.js", data: "hello" }]);
    expect(await gunzip(gzip(tar))).toEqual(tar);
  });

  it("falls back to fflate without DecompressionStream", async () => {
    const saved = globalThis.DecompressionStream;
    // @ts-expect-error -- removing the global for the fallback path
    delete globalThis.DecompressionStream;
    try {
      const tar = writeTar([{ path: "package/a.js", data: "hello" }]);
      expect(await gunzip(gzip(tar))).toEqual(tar);
    } finally {
      globalThis.DecompressionStream = saved;
    }
  });
});

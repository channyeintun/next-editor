// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertPackageName, binFileName, isValidPackageName, packageNameProblem } from "./names";

describe("package names", () => {
  it("accepts npm's valid names", () => {
    for (const name of ["react", "@types/node", "lodash.merge", "a-b_c~d", "JSONStream", "x1"]) {
      expect(packageNameProblem(name)).toBeNull();
    }
  });

  it("refuses names that would leave node_modules or break a URL", () => {
    for (const name of [
      "",
      "..",
      ".",
      ".bin",
      "_private",
      "../x",
      "a/b",
      "@scope",
      "@scope/",
      "@../x",
      "@s/../x",
      "@s/.x",
      "@s/a/b",
      " react",
      "a b",
      "a%2Fb",
      "node_modules",
      "favicon.ico",
      "a\\b",
      "x".repeat(215),
    ]) {
      expect(isValidPackageName(name)).toBe(false);
    }
    expect(() => assertPackageName("..")).toThrow(/Invalid package name/);
  });

  it("turns a bin name into a .bin file name", () => {
    expect(binFileName("tool")).toBe("tool");
    expect(binFileName("@s/tool")).toBe("tool");
    for (const name of ["", ".", "..", "../x", "a/b", "a\\b", "a..b"]) {
      expect(binFileName(name)).toBeNull();
    }
  });
});

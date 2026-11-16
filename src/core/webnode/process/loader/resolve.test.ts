// @vitest-environment node
// Module resolution on the fake runtime's filesystem: directory requests
// (`./`, `.`, `..`, `dir/`) and the per-turn probe cache.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { resolveSpecifier } from "./resolve";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime({ cwd: "/p" });
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

function write(path: string, text: string): void {
  fake.fs.writeFile(path, new TextEncoder().encode(text), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
}

function resolved(specifier: string, parent: string): string {
  const result = resolveSpecifier(specifier, parent, "require", []);
  return "filename" in result ? result.filename : `builtin:${result.builtin}`;
}

describe("directory requests", () => {
  it("resolves ./, ., .., and dir/ to the directory, not a sibling file", () => {
    fake.fs.mkdir("/p/dirs/src/utils/deep", true, 0o755);
    write("/p/dirs/src.js", "");
    write("/p/dirs/src/index.js", "");
    write("/p/dirs/src/utils.js", "");
    write("/p/dirs/src/utils/index.js", "");
    write("/p/dirs/src/utils/x.js", "");
    write("/p/dirs/src/utils/deep.js", "");
    write("/p/dirs/src/utils/deep/index.js", "");
    const parent = "/p/dirs/src/utils/x.js";
    expect(resolved("./", parent)).toBe("/p/dirs/src/utils/index.js");
    expect(resolved(".", parent)).toBe("/p/dirs/src/utils/index.js");
    expect(resolved("..", parent)).toBe("/p/dirs/src/index.js");
    expect(resolved("../", parent)).toBe("/p/dirs/src/index.js");
    expect(resolved("../utils/", parent)).toBe("/p/dirs/src/utils/index.js");
    expect(resolved("./deep/", parent)).toBe("/p/dirs/src/utils/deep/index.js");
    expect(resolved("./deep/.", parent)).toBe("/p/dirs/src/utils/deep/index.js");
    expect(resolved("/p/dirs/src/utils/", parent)).toBe("/p/dirs/src/utils/index.js");
    // Without the slash a file still wins, as in Node.
    expect(resolved("./deep", parent)).toBe("/p/dirs/src/utils/deep.js");
    expect(resolved("../utils", parent)).toBe("/p/dirs/src/utils.js");
  });

  it("does not take a file for a directory request when the directory has no index", () => {
    fake.fs.mkdir("/p/empty/lib", true, 0o755);
    write("/p/empty/lib.js", "");
    write("/p/empty/main.js", "");
    expect(() => resolved("./lib/", "/p/empty/main.js")).toThrow(/Cannot find module/);
    expect(resolved("./lib", "/p/empty/main.js")).toBe("/p/empty/lib.js");
  });

  it("resolves a package subpath with a trailing slash to its directory", () => {
    fake.fs.mkdir("/p/pkgs/node_modules/pkg/sub", true, 0o755);
    write("/p/pkgs/node_modules/pkg/package.json", "{}");
    write("/p/pkgs/node_modules/pkg/sub.js", "");
    write("/p/pkgs/node_modules/pkg/sub/index.js", "");
    write("/p/pkgs/main.js", "");
    expect(resolved("pkg/sub/", "/p/pkgs/main.js")).toBe("/p/pkgs/node_modules/pkg/sub/index.js");
    expect(resolved("pkg/sub", "/p/pkgs/main.js")).toBe("/p/pkgs/node_modules/pkg/sub.js");
  });

  it("resolves a file at the root", () => {
    write("/at-root.js", "");
    expect(resolved("./at-root", "/main.js")).toBe("/at-root.js");
  });
});

describe("probe cache", () => {
  it("finds a file written in the same turn after a failed lookup", () => {
    fake.fs.mkdir("/p/gen", true, 0o755);
    expect(() => resolved("./made", "/p/gen/main.js")).toThrow(/Cannot find module/);
    write("/p/gen/made.js", "");
    expect(resolved("./made", "/p/gen/main.js")).toBe("/p/gen/made.js");
  });
});

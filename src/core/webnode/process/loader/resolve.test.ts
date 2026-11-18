// @vitest-environment node
// Module resolution on the fake runtime's filesystem: directory requests
// (`./`, `.`, `..`, `dir/`) and the per-turn probe cache.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { findPackageScope, resolveSpecifier, unresolvedCandidates } from "./resolve";

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

describe("an import specifier is a URL reference", () => {
  function imported(specifier: string, parent: string): string {
    const result = resolveSpecifier(specifier, parent, "import", []);
    return "filename" in result ? result.filename + result.query : `builtin:${result.builtin}`;
  }

  function thrown(run: () => unknown): { name: string; code: unknown; message: string } {
    try {
      run();
    } catch (error) {
      const { name, message } = error as Error;
      return { name, code: (error as { code?: unknown }).code, message };
    }
    throw new Error("did not throw");
  }

  beforeEach(() => {
    fake.fs.mkdir("/p/u/sub dir", true, 0o755);
    fake.fs.mkdir("/p/u/node_modules/pkg", true, 0o755);
    write("/p/u/node_modules/pkg/package.json", '{"name":"pkg"}');
    write("/p/u/node_modules/pkg/a b.mjs", "");
    for (const name of [
      "sp ace.mjs",
      "per%cent.mjs",
      "ha#sh.mjs",
      "qu?es.mjs",
      "lit%20eral.mjs",
      "lit%20eral.cjs",
      "lit eral.cjs",
      "uni-é.mjs",
      "sub dir/in ner.mjs",
    ]) {
      write(`/p/u/${name}`, "");
    }
  });

  it("decodes the percent escapes of a relative, an absolute and a file: specifier", () => {
    const parent = "/p/u/main.mjs";
    expect(imported("./sp%20ace.mjs", parent)).toBe("/p/u/sp ace.mjs");
    expect(imported("./sp ace.mjs", parent)).toBe("/p/u/sp ace.mjs");
    expect(imported("./per%25cent.mjs", parent)).toBe("/p/u/per%cent.mjs");
    expect(imported("./sub%20dir/in%20ner.mjs", parent)).toBe("/p/u/sub dir/in ner.mjs");
    expect(imported("./ha%23sh.mjs", parent)).toBe("/p/u/ha#sh.mjs");
    expect(imported("./qu%3Fes.mjs", parent)).toBe("/p/u/qu?es.mjs");
    expect(imported("./lit%2520eral.mjs", parent)).toBe("/p/u/lit%20eral.mjs");
    expect(imported("./uni-%C3%A9.mjs", parent)).toBe("/p/u/uni-é.mjs");
    expect(imported("/p/u/sp%20ace.mjs", parent)).toBe("/p/u/sp ace.mjs");
    expect(imported("file:///p/u/sp%20ace.mjs", parent)).toBe("/p/u/sp ace.mjs");
    // An encoded dot segment is a dot segment, and a query stays a query.
    expect(imported("./%2e%2e/u/sp%20ace.mjs", parent)).toBe("/p/u/sp ace.mjs");
    expect(imported("./sp%20ace.mjs?v=%201", parent)).toBe("/p/u/sp ace.mjs?v=%201");
  });

  it("decodes the subpath of a package specifier", () => {
    expect(imported("pkg/a%20b.mjs", "/p/u/main.mjs")).toBe("/p/u/node_modules/pkg/a b.mjs");
    expect(imported("pkg/a b.mjs", "/p/u/main.mjs")).toBe("/p/u/node_modules/pkg/a b.mjs");
  });

  it("does not find the file whose name holds the escape itself, and names the file it looked for", () => {
    expect(thrown(() => imported("./lit%20eral.mjs", "/p/u/main.mjs"))).toEqual({
      name: "Error",
      code: "ERR_MODULE_NOT_FOUND",
      message: "Cannot find module '/p/u/lit eral.mjs' imported from /p/u/main.mjs",
    });
    expect(thrown(() => imported("../gone.mjs", "/p/u/main.mjs")).message).toBe(
      "Cannot find module '/p/gone.mjs' imported from /p/u/main.mjs",
    );
    expect(thrown(() => imported("file:///p/u/gone.mjs", "/p/u/main.mjs")).message).toBe(
      "Cannot find module '/p/u/gone.mjs' imported from /p/u/main.mjs",
    );
    expect(thrown(() => imported("no-such-pkg", "/p/u/main.mjs")).message).toBe(
      "Cannot find package 'no-such-pkg' imported from /p/u/main.mjs",
    );
  });

  it("refuses an encoded path separator, in Node's words", () => {
    for (const [specifier, named] of [
      ["./sub%20dir%2Fin%20ner.mjs", "/p/u/sub%20dir%2Fin%20ner.mjs"],
      ["./sub%20dir%5cin%20ner.mjs", "/p/u/sub%20dir%5cin%20ner.mjs"],
      ["file:///p/u/sub%20dir%2Fin%20ner.mjs", "/p/u/sub%20dir%2Fin%20ner.mjs"],
    ]) {
      expect(thrown(() => imported(specifier, "/p/u/main.mjs"))).toEqual({
        name: "TypeError",
        code: "ERR_INVALID_MODULE_SPECIFIER",
        message: `Invalid module "${named}" must not include encoded "/" or "\\" characters imported from /p/u/main.mjs`,
      });
    }
  });

  it("throws URIError for an escape that does not decode", () => {
    for (const specifier of ["./per%cent.mjs", "./100%.mjs"]) {
      expect(thrown(() => imported(specifier, "/p/u/main.mjs"))).toEqual({
        name: "URIError",
        code: undefined,
        message: "URI malformed",
      });
    }
  });

  it("leaves a require() request as it is written", () => {
    const parent = "/p/u/main.cjs";
    expect(resolved("./lit%20eral.cjs", parent)).toBe("/p/u/lit%20eral.cjs");
    expect(resolved("./lit eral.cjs", parent)).toBe("/p/u/lit eral.cjs");
    expect(thrown(() => resolved("./sp%20ace.mjs", parent)).code).toBe("MODULE_NOT_FOUND");
  });
});

describe("probe cache", () => {
  it("finds a file written in the same turn after a failed lookup", () => {
    fake.fs.mkdir("/p/gen", true, 0o755);
    expect(() => resolved("./made", "/p/gen/main.js")).toThrow(/Cannot find module/);
    write("/p/gen/made.js", "");
    expect(resolved("./made", "/p/gen/main.js")).toBe("/p/gen/made.js");
  });

  it("forgets what it found when the turn ends, whatever the program made of queueMicrotask", async () => {
    fake.fs.mkdir("/p/turn", true, 0o755);
    write("/p/turn/dep.js", "");
    const real = globalThis.queueMicrotask;
    // What a test's fake timers leave: jobs that wait for a clock nobody advances.
    globalThis.queueMicrotask = () => {};
    try {
      expect(resolved("./dep", "/p/turn/main.js")).toBe("/p/turn/dep.js");
      await Promise.resolve();
      fake.fs.unlink("/p/turn/dep.js");
      write("/p/turn/dep.json", "{}");
      // Another request for the same place: only the probes could remember it.
      expect(resolved("../turn/dep", "/p/turn/main.js")).toBe("/p/turn/dep.json");
    } finally {
      globalThis.queueMicrotask = real;
    }
  });
});

describe("what a failed require() looked for", () => {
  const all = (base: string) =>
    ["", ".js", ".json", ".node", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"].map(
      (extension) => base + extension,
    );

  it("names the path with each extension, and a .js request's TypeScript source", () => {
    fake.fs.mkdir("/p/w", true, 0o755);
    expect(unresolvedCandidates("./a", "/p/w/main.js")).toEqual(all("/p/w/a"));
    expect(unresolvedCandidates("../w/b.js", "/p/w/main.js")).toEqual([
      ...all("/p/w/b.js"),
      "/p/w/b.ts",
      "/p/w/b.tsx",
    ]);
    expect(unresolvedCandidates("/abs/c", "/p/w/main.js")).toEqual(all("/abs/c"));
    // A directory request adds nothing to the name.
    expect(unresolvedCandidates("./lib/", "/p/w/main.js")).toEqual(["/p/w/lib"]);
  });

  it("skips a folder that does not exist unless the request leaves it, as Node does", () => {
    expect(unresolvedCandidates("./a", "/p/gone/main.js")).toEqual([]);
    expect(unresolvedCandidates("../a", "/p/gone/main.js")).toEqual(all("/p/a"));
  });

  it("looks for a package in each node_modules folder that exists", () => {
    fake.fs.mkdir("/p/m/node_modules", true, 0o755);
    fake.fs.mkdir("/p/m/src", true, 0o755);
    expect(unresolvedCandidates("pkg/sub", "/p/m/src/main.js")).toEqual(
      all("/p/m/node_modules/pkg/sub"),
    );
    expect(unresolvedCandidates("#internal", "/p/m/src/main.js")).toEqual([]);
  });
});

describe("a package.json that cannot be read", () => {
  // Real node v26: Node's GetPackageJSON takes only ENOENT, ENOTDIR and
  // EISDIR for "no package.json"; any other read error is
  // ERR_INVALID_PACKAGE_CONFIG with uv_strerror's text.
  function failure(run: () => unknown): { code?: string; message: string } {
    try {
      run();
    } catch (error) {
      const { code, message } = error as { code?: string; message: string };
      return { code, message: message.split("\n")[0] };
    }
    throw new Error("expected the resolve to fail");
  }

  it("says it cannot read one it may not, through a directory it may not search too", () => {
    fake.fs.mkdir("/p/r/mdir", true, 0o755);
    write("/p/r/mdir/package.json", '{"main":"x.js"}');
    write("/p/r/mdir/x.js", "");
    fake.fs.mkdir("/p/r/node_modules/pkg", true, 0o755);
    write("/p/r/node_modules/pkg/package.json", '{"main":"i.js"}');
    write("/p/r/node_modules/pkg/i.js", "");
    fake.fs.mkdir("/p/r/scope/inner", true, 0o755);
    write("/p/r/scope/package.json", "{}");
    write("/p/r/scope/inner/m.js", "");
    write("/p/r/main.js", "");
    fake.fs.chmod("/p/r/mdir", 0o600, true);
    fake.fs.chmod("/p/r/node_modules/pkg/package.json", 0o200, true);
    fake.fs.chmod("/p/r/scope/package.json", 0, true);
    const denied = (path: string) => ({
      code: "ERR_INVALID_PACKAGE_CONFIG",
      message: `Cannot read package config ${path}: permission denied.`,
    });
    expect(failure(() => resolved("./mdir", "/p/r/main.js"))).toEqual(
      denied("/p/r/mdir/package.json"),
    );
    expect(failure(() => resolved("pkg", "/p/r/main.js"))).toEqual(
      denied("/p/r/node_modules/pkg/package.json"),
    );
    expect(failure(() => resolveSpecifier("pkg", "/p/r/main.js", "import", []))).toEqual(
      denied("/p/r/node_modules/pkg/package.json"),
    );
    expect(failure(() => findPackageScope("/p/r/scope/inner"))).toEqual(
      denied("/p/r/scope/package.json"),
    );
  });

  it("takes a missing one, or a directory by that name, for none", () => {
    fake.fs.mkdir("/p/n/dirpj/package.json", true, 0o755);
    write("/p/n/dirpj/index.js", "");
    fake.fs.mkdir("/p/n/dang", true, 0o755);
    fake.fs.symlink("nowhere", "/p/n/dang/package.json");
    write("/p/n/dang/index.js", "");
    write("/p/n/main.js", "");
    expect(resolved("./dirpj", "/p/n/main.js")).toBe("/p/n/dirpj/index.js");
    expect(resolved("./dang", "/p/n/main.js")).toBe("/p/n/dang/index.js");
  });

  it("names one that does not parse in Node's words", () => {
    fake.fs.mkdir("/p/b/bad", true, 0o755);
    write("/p/b/bad/package.json", "{bad");
    write("/p/b/bad/index.js", "");
    expect(failure(() => resolved("./bad", "/p/b/main.js"))).toEqual({
      code: "ERR_INVALID_PACKAGE_CONFIG",
      message: "Invalid package config /p/b/bad/package.json.",
    });
  });
});

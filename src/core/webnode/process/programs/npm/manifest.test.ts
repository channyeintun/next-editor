// @vitest-environment node
import { describe, expect, it } from "vitest";
import { addToManifest, detectIndent, removeFromManifest, rootDependencies } from "./manifest";
import { binEntries, nodeModulesOf } from "./bins";
import { Reporter, formatDuration } from "./output";
import type { Sink } from "./output";
import { PmError } from "./errors";

describe("manifest edits", () => {
  it("adds sorted entries and moves a name between lists", () => {
    const next = addToManifest(
      { name: "a", dependencies: { z: "1", vite: "^4" }, devDependencies: { b: "1" } },
      { vite: "^5.4.21", a: "^1.0.0" },
      "dev",
    );
    expect(next).toEqual({
      name: "a",
      dependencies: { z: "1" },
      devDependencies: { a: "^1.0.0", b: "1", vite: "^5.4.21" },
    });
  });

  it("removes names from every list", () => {
    const { manifest, removed } = removeFromManifest(
      { dependencies: { a: "1" }, devDependencies: { b: "1", a: "1" } },
      ["a", "c"],
    );
    expect(manifest).toEqual({ dependencies: {}, devDependencies: { b: "1" } });
    expect(removed).toEqual(["a"]);
  });

  it("lists root dependencies once, optional over prod over dev", () => {
    expect(
      rootDependencies({
        dependencies: { a: "1", b: "1" },
        devDependencies: { a: "2", c: "1" },
        optionalDependencies: { b: "3" },
      }),
    ).toEqual([
      { name: "a", spec: "1", type: "prod" },
      { name: "b", spec: "3", type: "optional" },
      { name: "c", spec: "1", type: "dev" },
    ]);
  });

  it("detects indentation", () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe("    ");
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectIndent("{}")).toBe("  ");
  });
});

describe("bin entries", () => {
  it("reads string and map bins, dropping scopes and escapes", () => {
    expect(binEntries({ name: "@s/tool", bin: "./cli.js" })).toEqual([["tool", "cli.js"]]);
    expect(
      binEntries({
        bin: { a: "bin/a", "../evil": "x", "x/y": "x", "a\\b": "x", "..": "x", b: "../../x" },
      }),
    ).toEqual([["a", "bin/a"]]);
    expect(binEntries({ bin: { "@s/c": "c.js" } })).toEqual([["c", "c.js"]]);
    expect(binEntries({ directories: { bin: "bin" } }, () => ["x", "y"])).toEqual([
      ["x", "bin/x"],
      ["y", "bin/y"],
    ]);
  });

  it("finds the node_modules of scoped and plain packages", () => {
    expect(nodeModulesOf("/p/node_modules/@s/a")).toBe("/p/node_modules");
    expect(nodeModulesOf("/p/node_modules/a/node_modules/b")).toBe(
      "/p/node_modules/a/node_modules",
    );
  });
});

describe("output", () => {
  function capture(isTTY = false) {
    const out: string[] = [];
    const err: string[] = [];
    const sink: Sink = {
      isTTY,
      columns: 80,
      write: (fd, text) => (fd === 1 ? out : err).push(text),
      flush: async () => {},
      lostReader: false,
      lostWrites: 0,
    };
    return { sink, out: () => out.join(""), err: () => err.join("") };
  }

  it("formats durations per tool", () => {
    expect(formatDuration("pnpm", 512)).toBe("512ms");
    expect(formatDuration("pnpm", 3210)).toBe("3.2s");
    expect(formatDuration("npm", 3210)).toBe("3s");
    expect(formatDuration("yarn", 3210)).toBe("3.21s");
  });

  it("prints npm's added and removed counts", () => {
    const io = capture();
    new Reporter("npm", io.sink).summary({ added: 2, removed: 1, direct: [], elapsedMs: 1500 });
    expect(io.out()).toBe("\nadded 2 packages, removed 1 package in 2s\n");
  });

  it("prints bun's summary", () => {
    const io = capture();
    new Reporter("bun", io.sink).summary({
      added: 3,
      removed: 0,
      direct: [{ name: "react", version: "19.0.0", type: "prod" }],
      elapsedMs: 1234,
    });
    expect(io.out()).toBe("\n+ react@19.0.0\n\n3 packages installed [1.23s]\n");
  });

  it("caps pnpm's bar at the terminal width", () => {
    const io = capture();
    new Reporter("pnpm", io.sink).summary({ added: 400, removed: 0, direct: [], elapsedMs: 10 });
    expect(io.out()).toContain(`Packages: +400\n${"+".repeat(80)}\n`);
  });

  it("prints errors and warnings in each voice", () => {
    const error = new PmError("ETARGET", "No matching version found for a@^9", [
      'The latest release of a is "1.0.0".',
    ]);
    const pnpm = capture();
    new Reporter("pnpm", pnpm.sink).error(error);
    expect(pnpm.err()).toBe(
      ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for a@^9\n\nThe latest release of a is "1.0.0".\n',
    );
    const npm = capture();
    new Reporter("npm", npm.sink).error(error);
    expect(npm.err()).toMatch(/^npm error code ETARGET\nnpm error No matching version/);
    const yarn = capture();
    new Reporter("yarn", yarn.sink).warn("careful");
    expect(yarn.err()).toBe("warning careful\n");
  });
});

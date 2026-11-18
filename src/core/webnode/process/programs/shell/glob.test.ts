// @vitest-environment node
// Pathname expansion against the permission bits: a component that holds a
// pattern needs its directory read, one without needs only a path that can
// be searched, as bash tests it with a stat.
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import type { SimpleCommand } from "./ast";
import { expandWords } from "./expand";
import type { ExpandContext } from "./expand";
import { parse } from "./parser";
import { sh } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

/** `nr` may be searched but not read (0311); `nx` may be read but not searched (0644). */
const SETUP = "mkdir nr nx; echo i > nr/in; echo i > nx/in; chmod 311 nr; chmod 644 nx; ";

describe("a pattern whose last component has no wildcard", () => {
  it("matches where the path can be reached, whether or not its directory can be listed", async () => {
    // bash: nr/in for both; nx/in cannot be reached.
    const r = await sh(`${SETUP}echo */in; echo n?/in`);
    expect(r.err).toBe("");
    expect(r.out).toBe("nr/in\nnr/in\n");
  });

  it("matches a name that is there and not one that is not", async () => {
    const r = await sh("mkdir a b; echo x > a/f; echo */f; echo */g; echo ?/f ?/g");
    expect(r.out).toBe("a/f\n*/g\na/f ?/g\n");
  });

  it("matches a dangling symbolic link by its name", async () => {
    const r = await sh("mkdir d; ln -s nowhere d/l; echo */l");
    expect(r.out).toBe("d/l\n");
  });
});

describe("a pattern whose last component has a wildcard", () => {
  it("needs to read the directory", async () => {
    // bash: `nr/i*` stays as written; `nx/i*` lists nx.
    const r = await sh(`${SETUP}echo nr/i*; echo nx/i*`);
    expect(r.out).toBe("nr/i*\nnx/in\n");
  });
});

describe("a pattern that ends in a slash", () => {
  it("keeps the directories, whether or not they can be listed", async () => {
    // bash: nr/ nx/.
    const r = await sh(`${SETUP}echo f > file; echo n*/; echo */`);
    expect(r.out).toBe("nr/ nx/\nnr/ nx/\n");
  });

  it("keeps a link to a directory and drops files and dangling links", async () => {
    const r = await sh("mkdir d; ln -s d ld; ln -s nowhere lx; echo f > f; echo */");
    expect(r.out).toBe("d/ ld/\n");
  });
});

describe("a pattern with a plain component in the middle", () => {
  it("goes through a directory that can be searched but not listed", async () => {
    const r = await sh(
      "mkdir -p a/mid b/mid; echo x > a/mid/f1; echo x > b/mid/f2; chmod 311 a; echo */mid/f*; echo */mid/",
    );
    expect(r.out).toBe("a/mid/f1 b/mid/f2\na/mid/ b/mid/\n");
  });
});

describe("a pattern with a great many matches", () => {
  it("expands them all", async () => {
    // More names than one call may take as arguments.
    const names = Array.from({ length: 300_000 }, (_, index) => `f${index}`);
    const context: ExpandContext = {
      get: () => undefined,
      set: () => {},
      positional: () => [],
      substitute: () => Promise.resolve(""),
      nounset: false,
      noglob: false,
      cwd: "/",
      readdir: () => names.map((name) => ({ name, isDir: false })),
      exists: () => true,
      isDirectory: () => false,
    };
    const command = parse("echo f*").items[0].andOr.first.commands[0] as SimpleCommand;
    const words = await expandWords(command.words, context);
    expect(words.length).toBe(names.length + 1);
    expect(words[1]).toBe("f0");
  });
});

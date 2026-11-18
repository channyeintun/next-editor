// @vitest-environment node
// The paths the shell itself opens: a redirection's target, a file `.`
// reads, the script it is started with. The filesystem resolves them, so
// `..` after a linked directory is that directory's parent and every
// directory on the way is checked, as for the same path given to a program.
// `cd` alone works on the path as written. Each expectation is what bash does.
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { runShell } from "./index";
import { readText, setupRuntime, sh } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

/** `link` leads to d/sub, so `link/..` is d; `x` and `s.sh` exist both here and in d. */
const LINKED = [
  "mkdir -p d/sub; ln -s d/sub link",
  "echo outer > x; echo inner > d/x",
  "echo 'echo sourced-outer' > s.sh; echo 'echo sourced-inner' > d/s.sh",
  "",
].join("; ");

describe("`..` after a linked directory in a path the shell opens", () => {
  it("is the parent of the directory the link leads to, for a redirection", async () => {
    const r = await sh(`${LINKED}echo new > link/../y; echo more >> link/../y; cat < link/../x`);
    expect(r.err).toBe("");
    expect(r.out).toBe("inner\n");
    expect(readText(r.vfs, "/work/d/y")).toBe("new\nmore\n");
    expect(r.vfs.exists("/work/y")).toBe(false);
  });

  it("is that for a sourced file and for the script the shell is started with", async () => {
    const r = await sh(`${LINKED}. link/../s.sh; source ./link/../s.sh`);
    expect(r.out).toBe("sourced-inner\nsourced-inner\n");
    const { rt, vfs } = setupRuntime({
      files: { "/work/s.sh": "echo outer\n", "/work/d/s.sh": "echo inner\n" },
    });
    vfs.mkdir("/work/d/sub", true, 0o755);
    vfs.symlink("d/sub", "/work/link");
    rt.feedStdin(null);
    expect(await runShell(["sh", "link/../s.sh"])).toBe(0);
    expect(rt.stdout()).toBe("inner\n");
  });

  it("stays the directory the link was entered from for `cd`, as written", async () => {
    const r = await sh(
      `${LINKED}cd link; pwd; cd ..; pwd; cd link/..; pwd; cd ""; echo "st=$?"; pwd`,
    );
    expect(r.err).toBe("");
    expect(r.out).toBe("/work/link\n/work\n/work\nst=0\n/work\n");
  });
});

describe("a directory a path the shell opens goes through and back out of", () => {
  it("must be searchable", async () => {
    const r = await sh(
      [
        "mkdir -p nx/sub; echo hi > f; echo 'echo sourced' > s.sh; chmod 000 nx",
        'echo y > nx/../g; echo "write st=$?"',
        'cat < nx/../f; echo "read st=$?"',
        '. nx/../s.sh; echo "source st=$?"',
      ].join("; "),
    );
    expect(r.out).toBe("write st=1\nread st=1\nsource st=1\n");
    expect(r.err).toBe(
      [
        "sh: nx/../g: Permission denied",
        "sh: nx/../f: Permission denied",
        "sh: nx/../s.sh: Permission denied",
        "",
      ].join("\n"),
    );
    expect(r.vfs.exists("/work/g")).toBe(false);
  });
});

describe("an empty word where the shell takes a path or a command name", () => {
  it("names no file to source, test or run, and never the shell's directory", async () => {
    const sourced = await sh('. ""; echo "st=$?"; source ""; echo "st=$?"');
    expect(sourced.out).toBe("st=1\nst=1\n");
    expect(sourced.err).toBe("sh: : No such file or directory\nsh: : No such file or directory\n");
    const tested = await sh(
      '[ -f "" ]; echo "f=$?"; [ -d "" ]; echo "d=$?"; [ -e "" ]; echo "e=$?"; test -r ""; echo "r=$?"; [[ -d "" ]]; echo "dd=$?"',
    );
    expect(tested.out).toBe("f=1\nd=1\ne=1\nr=1\ndd=1\n");
    const run = await sh('"" x; echo "st=$?"; type ""; echo "type=$?"; command -v ""; echo "v=$?"');
    expect(run.out).toBe("st=127\ntype=1\nv=1\n");
    expect(run.err).toBe("sh: command not found: \nsh: type: : not found\n");
    const script = await sh(["sh", ""]);
    expect(script.status).toBe(127);
    expect(script.err).toBe("sh: : No such file or directory\n");
  });
});

describe("an empty redirection target", () => {
  it("names no file: the shell's directory is not opened in its place", async () => {
    const r = await sh('echo x > ""; echo "write st=$?"; cat < ""; echo "read st=$?"');
    expect(r.out).toBe("write st=1\nread st=1\n");
    expect(r.err).toBe("sh: : No such file or directory\nsh: : No such file or directory\n");
  });

  it("is told apart from a missing directory and from a file used as one", async () => {
    const r = await sh('echo f > f; echo x > nodir/g; echo "st=$?"; echo x > f/g; echo "st=$?"');
    expect(r.out).toBe("st=1\nst=1\n");
    expect(r.err).toBe("sh: nodir/g: No such file or directory\nsh: f/g: Not a directory\n");
  });
});

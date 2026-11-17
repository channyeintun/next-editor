// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { runShell } from "../index";
import { setupRuntime, sh } from "../testHelpers";
import { runFilter, settle } from "./filterTesting";
import { grep } from "./grep";

afterEach(() => {
  setRuntime(null);
});

const letters = { "/work/l.txt": "a\nb\nc\nd\ne\nf\ng\nh\n" };

describe("grep", () => {
  it("writes each matching line before its input ends, through the shell", async () => {
    const { rt } = setupRuntime({});
    rt.feedStdin("booting\nserver ready\n");
    const done = runShell(["sh", "-c", "grep ready"]);
    await settle(100);
    expect(rt.stdout()).toBe("server ready\n");
    rt.feedStdin("again ready\n");
    rt.feedStdin(null);
    expect(await done).toBe(0);
    expect(rt.stdout()).toBe("server ready\nagain ready\n");
  });

  it("-l stops reading at the first match, and -m N after N matches", async () => {
    for (const args of [
      ["-l", "y"],
      ["-m", "1", "y"],
    ]) {
      const run = runFilter(grep, args);
      run.feed("y\n");
      await settle();
      expect(run.finished()).toBe(true);
    }
  });

  it("-q stops at the first match without waiting for the end of its input", async () => {
    const { rt } = setupRuntime({});
    rt.feedStdin("ready\n");
    const status = await Promise.race([
      runShell(["sh", "-c", "grep -q ready"]),
      new Promise((resolve) => setTimeout(() => resolve("still reading"), 200)),
    ]);
    expect(status).toBe(0);
  });

  it("--exclude-dir, and every --include and --exclude", async () => {
    const files = {
      "/work/a.txt": "alpha\n",
      "/work/dist/x.txt": "alpha\n",
      "/work/s/a.js": "hit\n",
      "/work/s/b.ts": "hit\n",
      "/work/s/c.md": "hit\n",
      "/work/s/node_modules/d.js": "hit\n",
    };
    const excluded = await sh("grep -r alpha . --exclude-dir=dist --exclude-dir=s", { files });
    expect(excluded.status).toBe(0);
    expect(excluded.out).toBe("a.txt:alpha\n");
    expect(
      (
        await sh("grep -rl hit s --include='*.js' --include='*.ts' --exclude-dir node_modules", {
          files,
        })
      ).out,
    ).toBe("s/a.js\ns/b.ts\n");
    expect((await sh("grep -rl hit s --exclude='*.js' --exclude='*.ts'", { files })).out).toBe(
      "s/c.md\n",
    );
  });

  it("prints context lines with -A, -B and -C (BSD/GNU output)", async () => {
    expect((await sh("grep -C1 e l.txt", { files: letters })).out).toBe("d\ne\nf\n");
    expect((await sh("grep -A1 -e b -e g l.txt", { files: letters })).out).toBe("b\nc\n--\ng\nh\n");
    expect((await sh("grep -n -B1 -A1 -e c -e e l.txt", { files: letters })).out).toBe(
      "2-b\n3:c\n4-d\n5:e\n6-f\n",
    );
    expect((await sh("grep -m1 -A2 b l.txt", { files: letters })).out).toBe("b\nc\nd\n");
    expect((await sh("grep -A1 -v '[a-f]' l.txt", { files: letters })).out).toBe("g\nh\n");
    expect((await sh("grep -c -A1 b l.txt", { files: letters })).out).toBe("1\n");
    expect((await sh("grep -A x b l.txt; echo $?", { files: letters })).out).toBe("2\n");
  });

  it("names files by the number of operands, and a directory operand is an error", async () => {
    const files = { "/work/a.txt": "alpha\n", "/work/dist/x": "alpha\n" };
    const dir = await sh("grep alpha dist a.txt", { files });
    expect(dir.out).toBe("a.txt:alpha\n");
    expect(dir.err).toBe("grep: dist: Is a directory\n");
    expect(dir.status).toBe(2);
    const missing = await sh("grep src nope -", { files, stdin: "src\n" });
    expect(missing.out).toBe("(standard input):src\n");
    expect(missing.status).toBe(2);
  });
});

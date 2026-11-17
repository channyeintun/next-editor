// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { O_APPEND, O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { setRuntime } from "../../../runtime";
import { runShell } from "../index";
import { setupRuntime, sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

const encoder = new TextEncoder();

describe("tail", () => {
  it("-f prints what is appended until interrupted", async () => {
    const { rt, vfs } = setupRuntime({ files: { "/work/log": "one\ntwo\n" } });
    rt.feedStdin(null);
    const done = runShell(["sh", "-c", "tail -n 1 -f log"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rt.stdout()).toBe("two\n");
    vfs.writeFile("/work/log", encoder.encode("three\n"), O_WRONLY | O_APPEND, 0o644);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(rt.stdout()).toBe("two\nthree\n");
    vfs.writeFile("/work/log", encoder.encode("new\n"), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(rt.stdout()).toBe("two\nthree\nnew\n");
    expect(rt.stderr()).toBe("tail: log: file truncated\n");
    rt.signal("SIGINT");
    expect(await done).toBe(130);
  });

  it("-f on standard input alone ends with the input", async () => {
    expect((await sh("tail -f", { stdin: "a\nb\n" })).out).toBe("a\nb\n");
  });

  it("keeps the bytes of a file that is not UTF-8, and a last line without newline", async () => {
    const { rt, vfs } = setupRuntime({});
    vfs.writeFile(
      "/work/bin",
      new Uint8Array([0x61, 0x0a, 0x62, 0xff, 0x0a]),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    rt.feedStdin(null);
    await runShell(["sh", "-c", "tail -n 1 bin > t1; tail -n +1 bin > t2"]);
    expect(Array.from(vfs.readFile("/work/t1"))).toEqual([0x62, 0xff, 0x0a]);
    expect(Array.from(vfs.readFile("/work/t2"))).toEqual([0x61, 0x0a, 0x62, 0xff, 0x0a]);
    const files = { "/work/n": "1\n2\n3" };
    expect((await sh("tail -n 2 n; echo; tail -n 0 n; tail -n +3 n", { files })).out).toBe(
      "2\n3\n3",
    );
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { setRuntime } from "../../../runtime";
import { runShell } from "../index";
import { setupRuntime, sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

describe("head", () => {
  it("-n 0 and -c 0 print nothing from standard input", async () => {
    expect((await sh("head -n 0", { stdin: "l1\nl2\n" })).out).toBe("");
    expect((await sh("head -c 0", { stdin: "l1\nl2\n" })).out).toBe("");
    expect((await sh("printf 'l1\\nl2\\n' | head -n 0; echo $?")).out).toBe("0\n");
  });

  it("keeps the bytes of a file that is not UTF-8", async () => {
    const { rt, vfs } = setupRuntime({});
    vfs.writeFile(
      "/work/bin",
      new Uint8Array([0x61, 0xff, 0x0a, 0x62, 0x0a]),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    rt.feedStdin(null);
    await runShell(["sh", "-c", "head -n 1 bin > h1; head -n -1 bin > h2; head -n 5 bin > h3"]);
    expect(Array.from(vfs.readFile("/work/h1"))).toEqual([0x61, 0xff, 0x0a]);
    expect(Array.from(vfs.readFile("/work/h2"))).toEqual([0x61, 0xff, 0x0a]);
    expect(Array.from(vfs.readFile("/work/h3"))).toEqual([0x61, 0xff, 0x0a, 0x62, 0x0a]);
  });

  it("keeps a last line without a newline as it is", async () => {
    const files = { "/work/n": "1\n2\n3" };
    expect((await sh("head -n 5 n; echo; head -n 2 n; head -n -1 n", { files })).out).toBe(
      "1\n2\n3\n1\n2\n1\n2\n",
    );
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { kernelShell, sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

describe("yes", () => {
  it("writes y until its reader has had enough", async () => {
    const result = await sh("yes | head -n 3; echo $?");
    expect(result.out).toBe("y\ny\ny\n0\n");
    expect(result.err).toBe("");
  });

  it("writes its arguments joined by spaces", async () => {
    const result = await sh("yes a 'b c' | head -n 2");
    expect(result.out).toBe("a b c\na b c\n");
  });

  it("keeps a reader that takes a lot supplied", async () => {
    const result = await sh("yes 0123456789 | head -n 20000 | wc -c");
    expect(result.out.trim()).toBe("220000");
  });

  it("ends with the pipe's status under pipefail", async () => {
    const result = await sh("set -o pipefail; yes | head -n 1; echo $?");
    expect(result.out).toBe("y\n141\n");
  });

  it("stops on Ctrl+C when nothing reads its output", async () => {
    const shell = kernelShell(["sh", "-c", "yes > /dev/null; echo after $?"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shell.type("\x03");
    expect(await shell.done).toBe(130);
    expect(shell.output()).not.toContain("after");
  });
});

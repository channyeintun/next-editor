// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { runShell } from "../index";
import { setupRuntime } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

/** The bytes `script` writes to the file `out`. */
async function bytesOf(script: string): Promise<number[]> {
  const { rt, vfs } = setupRuntime({});
  rt.feedStdin(null);
  await runShell(["sh", "-c", `${script} > out`]);
  return Array.from(vfs.readFile("/work/out"));
}

describe("printf and echo escapes name bytes", () => {
  it("\\NNN and \\xHH write single bytes (GNU printf)", async () => {
    expect(await bytesOf("printf '\\377'")).toEqual([0xff]);
    expect(await bytesOf("printf '\\xff\\x41'")).toEqual([0xff, 0x41]);
    expect(await bytesOf("printf '%b' '\\0377\\0101'")).toEqual([0xff, 0x41]);
    expect(await bytesOf("echo -e '\\xff'")).toEqual([0xff, 0x0a]);
    expect(await bytesOf("echo -e '\\0377'")).toEqual([0xff, 0x0a]);
  });

  it("escaped UTF-8 bytes make the character, and text stays UTF-8", async () => {
    expect(await bytesOf("printf '\\303\\251'")).toEqual([0xc3, 0xa9]);
    expect(await bytesOf("printf 'é\\n'")).toEqual([0xc3, 0xa9, 0x0a]);
    expect(await bytesOf("printf '\\101'")).toEqual([0x41]);
  });

  it("tr sets can name bytes", async () => {
    expect(await bytesOf("printf 'a\\377b' | tr '\\377' x")).toEqual([0x61, 0x78, 0x62]);
  });
});

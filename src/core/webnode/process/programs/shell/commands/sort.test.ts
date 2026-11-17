// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

/** Output of `printf input | sort args`; the expected values are GNU sort's (gsort). */
async function sorted(input: string, args: string): Promise<string> {
  return (await sh(`sort ${args}`, { stdin: input })).out;
}

describe("sort keys", () => {
  it("honours the modifiers on a key: -k2nr", async () => {
    expect(await sorted("a 3\nb 10\nc 2\n", "-k2nr")).toBe("b 10\na 3\nc 2\n");
  });

  it("uses every -k in order", async () => {
    expect(await sorted("x 2\nx 1\ny 0\n", "-k1,1 -k2,2n")).toBe("x 1\nx 2\ny 0\n");
    expect(await sorted("b 1\na 1\nc 2\n", "-k2,2nr -k1,1")).toBe("c 2\na 1\nb 1\n");
    expect(await sorted("b 1\na 1\nc 2\n", "--key=2,2n --key 1,1")).toBe("a 1\nb 1\nc 2\n");
  });

  it("a key with its own letters does not take the global ones", async () => {
    expect(await sorted("b 1\na 1\nc 2\n", "-r -k2,2n")).toBe("b 1\na 1\nc 2\n");
    expect(await sorted("a 1\nb 2\n", "-r -k2,2")).toBe("b 2\na 1\n");
  });

  it("f, h and -u on keys", async () => {
    expect(await sorted("B 1\na 2\n", "-k1f")).toBe("a 2\nB 1\n");
    expect(await sorted("x 2K\ny 1M\nz 3\n", "-k2h")).toBe("z 3\nx 2K\ny 1M\n");
    expect(await sorted("b 1\na 1\n", "-u -k2,2")).toBe("b 1\n");
  });

  it("rejects a bad key", async () => {
    const result = await sh("sort -k0 a", { stdin: "" });
    expect(result.err).toBe("sort: invalid key: '0'\n");
    expect(result.status).toBe(2);
  });
});

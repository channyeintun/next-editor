// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../../runtime";
import { sh } from "../testHelpers";

afterEach(() => {
  setRuntime(null);
});

const files = {
  "/work/dist/a.txt": "1",
  "/work/dist/sub/b.txt": "2",
  "/work/dist/empty/c": "3",
  "/work/keep.txt": "k",
};

describe("find -delete and -depth", () => {
  it("deletes a whole tree and exits 0", async () => {
    const result = await sh("find dist -delete; echo $?; ls", { files });
    expect(result.out).toBe("0\nkeep.txt\n");
    expect(result.err).toBe("");
  });

  it("does not read a directory it just deleted", async () => {
    const result = await sh("mkdir -p e/f; find e -type d -empty -delete; echo $?; ls", { files });
    expect(result.out).toBe("0\ndist\nkeep.txt\n");
    expect(result.err).toBe("");
  });

  it("deletes inside . but not . itself", async () => {
    const result = await sh("cd dist && find . -delete; echo $?; ls -A /work/dist | wc -l", {
      files,
    });
    expect(result.out).toBe("0\n0\n");
  });

  it("exits 1 when a deletion fails", async () => {
    const result = await sh("find dist -name sub -delete; echo $?", { files });
    expect(result.out).toBe("1\n");
    expect(result.err).toBe("find: cannot delete 'dist/sub': Directory not empty\n");
  });

  it("-depth lists entries before their directory", async () => {
    const result = await sh("find dist -depth", { files });
    expect(result.out).toBe(
      "dist/a.txt\ndist/empty/c\ndist/empty\ndist/sub/b.txt\ndist/sub\ndist\n",
    );
  });
});

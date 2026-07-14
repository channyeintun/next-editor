import { describe, expect, it } from "vitest";
import { treeToZip, zipToTree } from "./mountZip";
import type { FileSystemTree } from "./types";

describe("mount zip", () => {
  it("round-trips files, empty directories, symlinks, binary, and unicode", () => {
    const tree: FileSystemTree = {
      src: { directory: {
        "héllo.txt": { file: { contents: "hello" } },
        bytes: { file: { contents: new Uint8Array([0, 255, 1]) } },
      } },
      empty: { directory: {} },
      link: { file: { symlink: "src/héllo.txt" } },
    };
    const result = zipToTree(treeToZip(tree));
    expect(result.empty).toEqual({ directory: {} });
    expect(result.link).toEqual({ file: { symlink: "src/héllo.txt" } });
    expect((result.src as { directory: FileSystemTree }).directory.bytes)
      .toEqual({ file: { contents: new Uint8Array([0, 255, 1]) } });
  });

  it("rejects unsafe tree names", () => {
    expect(() => treeToZip({ "../oops": { file: { contents: "x" } } })).toThrow("EPROTO:");
  });
});

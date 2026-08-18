import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../../types/workspace";
import { areZigPlaygroundFilesEqual, collectZigPlaygroundFiles } from "./files";

describe("collectZigPlaygroundFiles", () => {
  it("collects every text Zig file main.zig-first and excludes assets", () => {
    const files: WorkspaceProject["files"] = {
      "extra.zig": {
        path: "extra.zig",
        name: "extra.zig",
        language: "zig",
        content: "fn extra() {}\n",
      },
      "main.zig": {
        path: "main.zig",
        name: "main.zig",
        language: "zig",
        content: "fn main() {}\n",
      },
      "binary.zig": {
        path: "binary.zig",
        name: "binary.zig",
        language: "zig",
        encoding: "asset",
        content: { kind: "asset", assetId: "asset-1", mimeType: "image/png", size: 1 },
      },
      "README.md": {
        path: "README.md",
        name: "README.md",
        language: "markdown",
        content: "lesson",
      },
    };

    expect(collectZigPlaygroundFiles({ files })).toEqual([
      { path: "main.zig", content: "fn main() {}\n" },
      { path: "extra.zig", content: "fn extra() {}\n" },
    ]);
  });
});

describe("areZigPlaygroundFilesEqual", () => {
  it("detects content and topology changes while a format request is in flight", () => {
    const files = [{ path: "main.zig", content: "fn main() {}\n" }];

    expect(areZigPlaygroundFilesEqual(files, files)).toBe(true);
    expect(
      areZigPlaygroundFilesEqual(files, [{ path: "main.zig", content: "fn main() {}\n\n" }]),
    ).toBe(false);
    expect(
      areZigPlaygroundFilesEqual(files, [...files, { path: "extra.zig", content: "fn e() {}\n" }]),
    ).toBe(false);
  });
});

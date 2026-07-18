import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../../types/workspace";
import { areGoPlaygroundFilesEqual, collectGoPlaygroundFiles } from "./files";

describe("collectGoPlaygroundFiles", () => {
  it("collects every text Go file in deterministic order and excludes assets", () => {
    const files: WorkspaceProject["files"] = {
      "helper.go": {
        path: "helper.go",
        name: "helper.go",
        language: "go",
        content: "package main\n",
      },
      "main.go": {
        path: "main.go",
        name: "main.go",
        language: "go",
        content: "package main\n\nfunc main() {}\n",
      },
      "binary.go": {
        path: "binary.go",
        name: "binary.go",
        language: "go",
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

    expect(collectGoPlaygroundFiles({ files })).toEqual([
      { path: "main.go", content: "package main\n\nfunc main() {}\n" },
      { path: "helper.go", content: "package main\n" },
    ]);
  });
});

describe("areGoPlaygroundFilesEqual", () => {
  it("detects content and topology changes while a format request is in flight", () => {
    const files = [{ path: "main.go", content: "package main\n" }];

    expect(areGoPlaygroundFilesEqual(files, files)).toBe(true);
    expect(
      areGoPlaygroundFilesEqual(files, [{ path: "main.go", content: "package main\n\n" }]),
    ).toBe(false);
    expect(
      areGoPlaygroundFilesEqual(files, [
        ...files,
        { path: "helper.go", content: "package main\n" },
      ]),
    ).toBe(false);
  });
});

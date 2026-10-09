import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceProject } from "../../types/workspace";
import { collectRustPlaygroundFiles } from "./files";

describe("collectRustPlaygroundFiles", () => {
  it("collects every text Rust file main.rs-first and excludes assets", () => {
    const files: WorkspaceProject["files"] = {
      "extra.rs": {
        path: "extra.rs",
        name: "extra.rs",
        language: "rust",
        content: "fn extra() {}\n",
      },
      "main.rs": {
        path: "main.rs",
        name: "main.rs",
        language: "rust",
        content: "fn main() {}\n",
      },
      "binary.rs": {
        path: "binary.rs",
        name: "binary.rs",
        language: "rust",
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

    expect(collectRustPlaygroundFiles({ files })).toEqual([
      { path: "main.rs", content: "fn main() {}\n" },
      { path: "extra.rs", content: "fn extra() {}\n" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../../types/workspace";
import { collectKotlinPlaygroundFiles } from "./files";

describe("collectKotlinPlaygroundFiles", () => {
  it("collects every text Kotlin file in deterministic order and excludes assets", () => {
    const files: WorkspaceProject["files"] = {
      "Helper.kt": {
        path: "Helper.kt",
        name: "Helper.kt",
        language: "kotlin",
        content: "fun helper() = 1\n",
      },
      "Main.kt": {
        path: "Main.kt",
        name: "Main.kt",
        language: "kotlin",
        content: "fun main() {}\n",
      },
      "binary.kt": {
        path: "binary.kt",
        name: "binary.kt",
        language: "kotlin",
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

    expect(collectKotlinPlaygroundFiles({ files })).toEqual([
      { path: "Main.kt", content: "fun main() {}\n" },
      { path: "Helper.kt", content: "fun helper() = 1\n" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../../types/workspace";
import { collectHaskellPlaygroundFiles } from "./files";

describe("collectHaskellPlaygroundFiles", () => {
  it("collects every text Haskell file Main.hs-first and excludes assets", () => {
    const files: WorkspaceProject["files"] = {
      "Extra.hs": {
        path: "Extra.hs",
        name: "Extra.hs",
        language: "haskell",
        content: "extra :: Int\nextra = 1\n",
      },
      "Main.hs": {
        path: "Main.hs",
        name: "Main.hs",
        language: "haskell",
        content: "main :: IO ()\nmain = pure ()\n",
      },
      "binary.hs": {
        path: "binary.hs",
        name: "binary.hs",
        language: "haskell",
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

    expect(collectHaskellPlaygroundFiles({ files })).toEqual([
      { path: "Main.hs", content: "main :: IO ()\nmain = pure ()\n" },
      { path: "Extra.hs", content: "extra :: Int\nextra = 1\n" },
    ]);
  });

  it("excludes literate Haskell, which the Playground cannot compile", () => {
    // `.lhs` holds the same language in a different source format — code in
    // '>'-prefixed lines — so sending one upstream would fail to parse rather
    // than run. The suffix check already rejects it; this pins that it does.
    const files: WorkspaceProject["files"] = {
      "Main.hs": {
        path: "Main.hs",
        name: "Main.hs",
        language: "haskell",
        content: "main :: IO ()\nmain = pure ()\n",
      },
      "Notes.lhs": {
        path: "Notes.lhs",
        name: "Notes.lhs",
        language: "haskell",
        content: "The literate version:\n\n> notes :: Int\n> notes = 1\n",
      },
    };

    expect(collectHaskellPlaygroundFiles({ files })).toEqual([
      { path: "Main.hs", content: "main :: IO ()\nmain = pure ()\n" },
    ]);
  });

  it("orders the rest by path so the same workspace always sends the same request", () => {
    const files: WorkspaceProject["files"] = {
      "Zeta.hs": { path: "Zeta.hs", name: "Zeta.hs", language: "haskell", content: "zeta = 3\n" },
      "Alpha.hs": {
        path: "Alpha.hs",
        name: "Alpha.hs",
        language: "haskell",
        content: "alpha = 1\n",
      },
      "Main.hs": {
        path: "Main.hs",
        name: "Main.hs",
        language: "haskell",
        content: "main = pure ()\n",
      },
    };

    expect(collectHaskellPlaygroundFiles({ files }).map((file) => file.path)).toEqual([
      "Main.hs",
      "Alpha.hs",
      "Zeta.hs",
    ]);
  });
});

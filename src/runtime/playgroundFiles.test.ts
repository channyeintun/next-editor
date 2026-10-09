import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceFile, WorkspaceProject } from "../types/workspace";
import { collectAsmPlaygroundFiles } from "./asmPlayground/files";
import { collectGoPlaygroundFiles } from "./goPlayground/files";
import { collectHaskellPlaygroundFiles } from "./haskellPlayground/files";
import { collectKitePlaygroundFiles } from "./kitePlayground/files";
import { collectKotlinPlaygroundFiles } from "./kotlinPlayground/files";
import {
  arePlaygroundFilesEqual,
  collectPlaygroundFiles,
  PLAYGROUND_SOURCE_RULES,
} from "./playgroundFiles";
import { collectRustPlaygroundFiles } from "./rustPlayground/files";
import { collectZigPlaygroundFiles } from "./zigPlayground/files";

function textFile(path: string, content: string): WorkspaceFile {
  return { path, name: path, language: "plaintext", content };
}

function project(...files: WorkspaceFile[]): Pick<WorkspaceProject, "files"> {
  return { files: Object.fromEntries(files.map((file) => [file.path, file])) };
}

describe("collectPlaygroundFiles", () => {
  it("takes the text files with a source extension, entry first and the rest by path", () => {
    const workspace = project(
      textFile("z.s", "nop\n"),
      textFile("notes.md", "# notes"),
      textFile("b.asm", "b\n"),
      textFile("main.asm", "main\n"),
      textFile("boot.nasm", "boot\n"),
      {
        path: "logo.asm",
        name: "logo.asm",
        language: "plaintext",
        content: { kind: "asset", assetId: "a1", mimeType: "image/png", size: 1 },
        encoding: "asset",
      },
    );

    expect(
      collectPlaygroundFiles(workspace, {
        extensions: [".asm", ".s", ".nasm"],
        entryPath: "main.asm",
      }),
    ).toEqual([
      { path: "main.asm", content: "main\n" },
      { path: "b.asm", content: "b\n" },
      { path: "boot.nasm", content: "boot\n" },
      { path: "z.s", content: "nop\n" },
    ]);
  });

  it("returns only the path and content of each file", () => {
    expect(
      collectPlaygroundFiles(project(textFile("main.go", "package main\n")), {
        extensions: [".go"],
        entryPath: "main.go",
      }),
    ).toStrictEqual([{ path: "main.go", content: "package main\n" }]);
  });
});

describe("PLAYGROUND_SOURCE_RULES", () => {
  it("names each language's entry file and source extensions", () => {
    expect(PLAYGROUND_SOURCE_RULES).toStrictEqual({
      go: { entryPath: "main.go", extensions: [".go"] },
      rust: { entryPath: "main.rs", extensions: [".rs"] },
      kotlin: { entryPath: "Main.kt", extensions: [".kt"] },
      zig: { entryPath: "main.zig", extensions: [".zig"] },
      haskell: { entryPath: "Main.hs", extensions: [".hs"] },
      asm: { entryPath: "main.asm", extensions: [".asm", ".s", ".nasm"] },
      kite: { entryPath: "main.kite", extensions: [".kite"] },
    });
  });

  it("is the rule each language's collector applies, entry first", () => {
    const workspace = project(
      ...[
        "a.go",
        "main.go",
        "a.rs",
        "main.rs",
        "A.kt",
        "Main.kt",
        "a.zig",
        "main.zig",
        "A.hs",
        "Main.hs",
        "Notes.lhs",
        "a.s",
        "boot.nasm",
        "main.asm",
        "a.kite",
        "main.kite",
        "README.md",
      ].map((path) => textFile(path, path)),
    );
    const paths = (files: readonly { path: string }[]) => files.map((file) => file.path);

    expect(paths(collectGoPlaygroundFiles(workspace))).toEqual(["main.go", "a.go"]);
    expect(paths(collectRustPlaygroundFiles(workspace))).toEqual(["main.rs", "a.rs"]);
    expect(paths(collectKotlinPlaygroundFiles(workspace))).toEqual(["Main.kt", "A.kt"]);
    expect(paths(collectZigPlaygroundFiles(workspace))).toEqual(["main.zig", "a.zig"]);
    expect(paths(collectHaskellPlaygroundFiles(workspace))).toEqual(["Main.hs", "A.hs"]);
    expect(paths(collectAsmPlaygroundFiles(workspace))).toEqual(["main.asm", "a.s", "boot.nasm"]);
    expect(paths(collectKitePlaygroundFiles(workspace))).toEqual(["main.kite", "a.kite"]);
  });
});

describe("arePlaygroundFilesEqual", () => {
  const files = [
    { path: "main.go", content: "package main\n" },
    { path: "util.go", content: "package main\n" },
  ];

  it("compares paths and contents in order", () => {
    expect(
      arePlaygroundFilesEqual(
        files,
        files.map((file) => ({ ...file })),
      ),
    ).toBe(true);
    expect(arePlaygroundFilesEqual(files, [...files].reverse())).toBe(false);
    expect(arePlaygroundFilesEqual(files, files.slice(0, 1))).toBe(false);
    expect(
      arePlaygroundFilesEqual(files, [files[0], { path: "util.go", content: "package util\n" }]),
    ).toBe(false);
  });
});

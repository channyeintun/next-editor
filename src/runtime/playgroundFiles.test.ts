import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceFile, WorkspaceProject } from "../types/workspace";
import { arePlaygroundFilesEqual, collectPlaygroundFiles } from "./playgroundFiles";

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

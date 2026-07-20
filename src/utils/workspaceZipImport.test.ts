import { zipSync, strToU8, type Zippable } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { isWorkspaceAssetFile, type WorkspaceFile } from "../types/workspace";
import {
  getWorkspaceAssetBytes,
  resetWorkspaceAssetStoreForTests,
} from "../storage/workspaceAssetStore";
import {
  createRootFolderStripper,
  deriveProjectNameFromFileName,
  detectImportedLessonType,
  importWorkspaceProjectFromZip,
  WorkspaceZipImportError,
} from "./workspaceZipImport";

afterEach(() => resetWorkspaceAssetStoreForTests());

function textFile(path: string, content: string): WorkspaceFile {
  return { path, name: path, language: "plaintext", content };
}

function createZipFile(
  name: string,
  entries: Array<{ path: string; content: string | Uint8Array }>,
): File {
  const zippable: Zippable = {};

  for (const entry of entries) {
    zippable[entry.path] =
      typeof entry.content === "string" ? strToU8(entry.content) : entry.content;
  }

  const bytes = zipSync(zippable);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);

  return new File([arrayBuffer], name, { type: "application/zip" });
}

describe("createRootFolderStripper", () => {
  it("strips a single shared wrapper folder", () => {
    const strip = createRootFolderStripper(["my-app/package.json", "my-app/src/main.ts"]);

    expect(strip("my-app/package.json")).toBe("package.json");
    expect(strip("my-app/src/main.ts")).toBe("src/main.ts");
  });

  it("leaves root-level files untouched", () => {
    const strip = createRootFolderStripper(["package.json", "src/main.ts"]);

    expect(strip("package.json")).toBe("package.json");
    expect(strip("src/main.ts")).toBe("src/main.ts");
  });

  it("does not strip when a file lives outside the wrapper", () => {
    const strip = createRootFolderStripper(["my-app/package.json", "README.md"]);

    expect(strip("my-app/package.json")).toBe("my-app/package.json");
    expect(strip("README.md")).toBe("README.md");
  });
});

describe("detectImportedLessonType", () => {
  const withPackageJson = (pkg: object): Record<string, WorkspaceFile> => ({
    "package.json": textFile("package.json", JSON.stringify(pkg)),
  });

  it("detects frameworks from dependencies", () => {
    expect(detectImportedLessonType(withPackageJson({ dependencies: { vue: "^3.0.0" } }))).toBe(
      "vue",
    );
    expect(detectImportedLessonType(withPackageJson({ dependencies: { svelte: "^4.0.0" } }))).toBe(
      "svelte",
    );
    expect(
      detectImportedLessonType(withPackageJson({ dependencies: { "solid-js": "^1.0.0" } })),
    ).toBe("solid");
    expect(detectImportedLessonType(withPackageJson({ dependencies: { react: "^19.0.0" } }))).toBe(
      "react",
    );
    expect(detectImportedLessonType(withPackageJson({ dependencies: { express: "^4.0.0" } }))).toBe(
      "htmx-express",
    );
  });

  it("detects Alpine AJAX from a CDN reference over the bare-Express fallback", () => {
    expect(
      detectImportedLessonType({
        ...withPackageJson({ dependencies: { express: "^5.1.0" } }),
        "public/index.html": textFile(
          "public/index.html",
          '<script src="https://cdn.jsdelivr.net/npm/@imacrayon/alpine-ajax@0.12.0/dist/cdn.min.js"></script>',
        ),
      }),
    ).toBe("alpine-express");

    expect(
      detectImportedLessonType(
        withPackageJson({ dependencies: { "@imacrayon/alpine-ajax": "^0.12.0" } }),
      ),
    ).toBe("alpine-express");
  });

  it("detects playground lessons from their canonical entry files", () => {
    expect(detectImportedLessonType({ "main.go": textFile("main.go", "package main\n") })).toBe(
      "go",
    );
    expect(detectImportedLessonType({ "main.rs": textFile("main.rs", "fn main() {}\n") })).toBe(
      "rust",
    );
    expect(detectImportedLessonType({ "Main.kt": textFile("Main.kt", "fun main() {}\n") })).toBe(
      "kotlin",
    );
  });

  it("detects playground lessons from sources without a canonical entry", () => {
    expect(
      detectImportedLessonType({
        "01-basics.go": textFile("01-basics.go", "package main\n"),
        "README.md": textFile("README.md", "# Lessons"),
      }),
    ).toBe("go");
    expect(detectImportedLessonType({ "lib.rs": textFile("lib.rs", "") })).toBe("rust");
    expect(detectImportedLessonType({ "Greeting.kt": textFile("Greeting.kt", "") })).toBe("kotlin");
  });

  it("lets the canonical entry decide when an archive mixes playground languages", () => {
    expect(
      detectImportedLessonType({
        "Main.kt": textFile("Main.kt", "fun main() {}\n"),
        "notes.go": textFile("notes.go", "package main\n"),
      }),
    ).toBe("kotlin");
  });

  it("keeps manifest detection ahead of playground sources", () => {
    expect(
      detectImportedLessonType({
        ...withPackageJson({ dependencies: { react: "^19.0.0" } }),
        "main.go": textFile("main.go", "package main\n"),
      }),
    ).toBe("react");
  });

  it("falls back to html-css without a manifest or recognized framework", () => {
    expect(detectImportedLessonType({})).toBe("html-css");
    expect(detectImportedLessonType(withPackageJson({ dependencies: { lodash: "^4.0.0" } }))).toBe(
      "html-css",
    );
  });

  it("falls back to html-css for an unparseable manifest", () => {
    expect(
      detectImportedLessonType({ "package.json": textFile("package.json", "{ not json") }),
    ).toBe("html-css");
  });
});

describe("deriveProjectNameFromFileName", () => {
  it("strips the .zip suffix", () => {
    expect(deriveProjectNameFromFileName("my-cool-app.zip")).toBe("my-cool-app");
    expect(deriveProjectNameFromFileName("My-App.ZIP")).toBe("My-App");
  });

  it("falls back when the name is empty", () => {
    expect(deriveProjectNameFromFileName(".zip")).toBe("Imported Project");
  });
});

describe("importWorkspaceProjectFromZip", () => {
  it("imports text files and detects the framework", async () => {
    const file = createZipFile("react-app.zip", [
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19.0.0" } }) },
      { path: "src/App.tsx", content: "export default function App() { return null; }" },
      { path: "index.html", content: "<!doctype html>" },
    ]);

    const project = await importWorkspaceProjectFromZip(file);

    expect(project.name).toBe("react-app");
    expect(project.lessonType).toBe("react");
    expect(project.entryFilePath).toBe("src/App.tsx");
    expect(Object.keys(project.files).sort()).toEqual([
      "index.html",
      "package.json",
      "src/App.tsx",
    ]);
    expect(project.files["src/App.tsx"].language).toBe("typescript");
    expect(project.folders).toContain("src");
  });

  it("strips a single top-level wrapper folder", async () => {
    const file = createZipFile("wrapped.zip", [
      { path: "wrapped/index.html", content: "<!doctype html>" },
      { path: "wrapped/styles.css", content: "body{}" },
    ]);

    const project = await importWorkspaceProjectFromZip(file);

    expect(Object.keys(project.files).sort()).toEqual(["index.html", "styles.css"]);
  });

  it("imports a wrapped Go lesson zip as a go workspace entered at main.go", async () => {
    const file = createZipFile("go-tour-lessons.zip", [
      { path: "go-tour-lessons/01-packages.go", content: "package main\n" },
      { path: "go-tour-lessons/main.go", content: "package main\n\nfunc main() {}\n" },
    ]);

    const project = await importWorkspaceProjectFromZip(file);

    expect(project.lessonType).toBe("go");
    expect(project.entryFilePath).toBe("main.go");
    expect(Object.keys(project.files).sort()).toEqual(["01-packages.go", "main.go"]);
  });

  it("imports Rust and Kotlin lesson zips with their canonical entries", async () => {
    const rust = await importWorkspaceProjectFromZip(
      createZipFile("rust-lesson.zip", [
        { path: "main.rs", content: "fn main() {}\n" },
        { path: "README.md", content: "# Rust\n" },
      ]),
    );
    expect(rust.lessonType).toBe("rust");
    expect(rust.entryFilePath).toBe("main.rs");

    const kotlin = await importWorkspaceProjectFromZip(
      createZipFile("kotlin-lesson.zip", [
        { path: "Greeting.kt", content: "fun greet() {}\n" },
        { path: "Main.kt", content: "fun main() {}\n" },
      ]),
    );
    expect(kotlin.lessonType).toBe("kotlin");
    expect(kotlin.entryFilePath).toBe("Main.kt");
  });

  it("stores binary assets behind descriptors and excludes dev artifacts", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = createZipFile("assets.zip", [
      { path: "index.html", content: "<!doctype html>" },
      { path: "logo.png", content: pngBytes },
      { path: "node_modules/left-pad/index.js", content: "module.exports = () => {};" },
      { path: ".git/config", content: "[core]" },
      { path: ".DS_Store", content: "junk" },
    ]);

    const project = await importWorkspaceProjectFromZip(file);

    expect(Object.keys(project.files).sort()).toEqual(["index.html", "logo.png"]);
    const assetFile = project.files["logo.png"];
    expect(isWorkspaceAssetFile(assetFile)).toBe(true);
    if (!isWorkspaceAssetFile(assetFile)) throw new Error("Expected asset file");
    expect(await getWorkspaceAssetBytes(assetFile.content)).toEqual(pngBytes);
  });

  it("rejects a zip without importable files", async () => {
    const file = createZipFile("empty.zip", [{ path: "node_modules/dep/index.js", content: "x" }]);

    await expect(importWorkspaceProjectFromZip(file)).rejects.toBeInstanceOf(
      WorkspaceZipImportError,
    );
  });

  it("rejects paths that escape the workspace root", async () => {
    const paths = ["../outside.ts", "nested/../../outside.ts", "nested\\..\\..\\outside.ts"];

    for (const path of paths) {
      const file = createZipFile("traversal.zip", [
        { path, content: "export const escaped = true" },
      ]);
      await expect(importWorkspaceProjectFromZip(file)).rejects.toThrow(/unsafe path/i);
    }
  });

  it("rejects record-special path segments", async () => {
    const file = createZipFile("reserved.zip", [
      { path: "src/__proto__/secret.ts", content: "secret" },
    ]);

    await expect(importWorkspaceProjectFromZip(file)).rejects.toThrow(/unsafe path/i);
  });

  it("rejects canonical duplicates and file-directory conflicts", async () => {
    const duplicate = createZipFile("duplicate.zip", [
      { path: "index.html", content: "first" },
      { path: "src/../index.html", content: "second" },
    ]);
    await expect(importWorkspaceProjectFromZip(duplicate)).rejects.toThrow(/same workspace path/i);

    const conflict = createZipFile("conflict.zip", [
      { path: "src", content: "file" },
      { path: "src/App.tsx", content: "nested" },
    ]);
    await expect(importWorkspaceProjectFromZip(conflict)).rejects.toThrow(
      /both a file and a directory/i,
    );
  });

  it("rejects a file that is not a valid zip", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "broken.zip", {
      type: "application/zip",
    });

    await expect(importWorkspaceProjectFromZip(file)).rejects.toBeInstanceOf(
      WorkspaceZipImportError,
    );
  });
});

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { base64ToBytes, type WorkspaceFile } from "../types/workspace";
import {
  createRootFolderStripper,
  deriveProjectNameFromFileName,
  detectImportedLessonType,
  importWorkspaceProjectFromZip,
  WorkspaceZipImportError,
} from "./workspaceZipImport";

function textFile(path: string, content: string): WorkspaceFile {
  return { path, name: path, language: "plaintext", content };
}

async function createZipFile(
  name: string,
  entries: Array<{ path: string; content: string | Uint8Array }>,
): Promise<File> {
  const zip = new JSZip();

  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }

  const bytes = await zip.generateAsync({ type: "uint8array" });
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
    const file = await createZipFile("react-app.zip", [
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
    const file = await createZipFile("wrapped.zip", [
      { path: "wrapped/index.html", content: "<!doctype html>" },
      { path: "wrapped/styles.css", content: "body{}" },
    ]);

    const project = await importWorkspaceProjectFromZip(file);

    expect(Object.keys(project.files).sort()).toEqual(["index.html", "styles.css"]);
  });

  it("stores binary assets as base64 and excludes dev artifacts", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = await createZipFile("assets.zip", [
      { path: "index.html", content: "<!doctype html>" },
      { path: "logo.png", content: pngBytes },
      { path: "node_modules/left-pad/index.js", content: "module.exports = () => {};" },
      { path: ".git/config", content: "[core]" },
      { path: ".DS_Store", content: "junk" },
    ]);

    const project = await importWorkspaceProjectFromZip(file);

    expect(Object.keys(project.files).sort()).toEqual(["index.html", "logo.png"]);
    expect(project.files["logo.png"].encoding).toBe("base64");
    expect(base64ToBytes(project.files["logo.png"].content)).toEqual(pngBytes);
  });

  it("rejects a zip without importable files", async () => {
    const file = await createZipFile("empty.zip", [
      { path: "node_modules/dep/index.js", content: "x" },
    ]);

    await expect(importWorkspaceProjectFromZip(file)).rejects.toBeInstanceOf(
      WorkspaceZipImportError,
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

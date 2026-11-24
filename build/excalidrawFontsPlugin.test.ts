// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  excalidrawAssetPath,
  excalidrawFontFile,
  excalidrawFontFiles,
} from "./excalidrawFontsPlugin";

const installedVersion = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../node_modules/@excalidraw/excalidraw/package.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { version: string }
).version;

describe("where the app serves Excalidraw's fonts", () => {
  // The Worker caches everything under /assets for a year, so a path must
  // never come to mean other bytes: an upgrade has to move the fonts.
  it("is under the build's assets, named by the installed version", () => {
    expect(excalidrawAssetPath()).toBe(`/assets/excalidraw-${installedVersion}/`);
    expect(excalidrawAssetPath("static")).toBe(`/static/excalidraw-${installedVersion}/`);
  });
});

describe("the fonts Excalidraw ships", () => {
  const files = excalidrawFontFiles();

  it("include the font every studio label is set in", () => {
    expect(files).toContain("Virgil/Virgil-Regular.woff2");
  });

  it("are all woff2, which is the type the dev server answers with", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !file.endsWith(".woff2"))).toEqual([]);
  });
});

describe("a request to the asset path", () => {
  const assetPath = "/assets/excalidraw-1.2.3/";
  const files = new Set(excalidrawFontFiles());
  const resolve = (pathname: string) => excalidrawFontFile(pathname, assetPath, files);

  it("resolves a font Excalidraw ships to its file", () => {
    const file = resolve("/assets/excalidraw-1.2.3/fonts/Virgil/Virgil-Regular.woff2");
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);
  });

  it("resolves nothing else", () => {
    expect(resolve("/assets/excalidraw-1.2.3/fonts/Virgil/Missing.woff2")).toBeNull();
    expect(resolve("/assets/excalidraw-1.2.3/fonts/../../package.json")).toBeNull();
    expect(resolve("/assets/excalidraw-1.2.3/fonts/%2E%2E/%2E%2E/package.json")).toBeNull();
    expect(resolve("/assets/excalidraw-1.2.3/fonts/%E0%A4%A")).toBeNull();
    expect(resolve("/assets/excalidraw-9.9.9/fonts/Virgil/Virgil-Regular.woff2")).toBeNull();
    expect(resolve("/fonts/Virgil/Virgil-Regular.woff2")).toBeNull();
  });
});

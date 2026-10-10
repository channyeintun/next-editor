// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { precompressAssets } from "../../build/precompressAssetsPlugin";
import { isPrecompressedCopy, precompressedContentType } from "./precompressedAssets";

describe("precompressedContentType", () => {
  it.each([
    ["/assets/editor-DiCQPGpO.js", "text/javascript"],
    ["/assets/ort-wasm-simd-threaded-qyIweqWS.mjs", "text/javascript"],
    ["/assets/editor-qTD-xyL8.css", "text/css"],
    ["/assets/next-editor-dmp-CGeFVXWD.wasm", "application/wasm"],
    ["/assets/codicon-DF1abBS2.ttf", "font/ttf"],
    ["/assets/data-abc.json", "application/json"],
    ["/assets/icon-abc.svg", "image/svg+xml"],
    ["/assets/Upper-abc.JS", "text/javascript"],
  ])("types %s as %s", (path, contentType) => {
    expect(precompressedContentType(path)).toBe(contentType);
  });

  it.each([
    "/assets/font-abc.woff2",
    "/assets/ts.worker-abc.js.map",
    "/assets/editor-abc.js.br",
    "/assets/no-extension",
    "/assets.d/no-extension",
  ])("leaves %s without a copy", (path) => {
    expect(precompressedContentType(path)).toBeUndefined();
  });

  it("recognises a copy by its suffix", () => {
    expect(isPrecompressedCopy("/assets/editor-abc.js.br")).toBe(true);
    expect(isPrecompressedCopy("/assets/editor-abc.js")).toBe(false);
  });
});

describe("precompressAssets", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("writes a decodable Brotli copy beside exactly the files the Worker looks up", async () => {
    dir = await mkdtemp(join(tmpdir(), "precompress-"));
    const files: Record<string, string> = {
      "Editor-abc.js": "export const editor = 1;\n".repeat(100),
      "editor-abc.css": ".monaco-editor { color: red }\n".repeat(100),
      "codec-abc.wasm": "\0asm".repeat(100),
      "font-abc.woff2": "wOF2",
      "ts.worker-abc.js.map": "{}",
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }

    const compressed = await precompressAssets(dir);

    expect(compressed.sort()).toEqual(["Editor-abc.js", "codec-abc.wasm", "editor-abc.css"]);
    expect((await readdir(dir)).filter(isPrecompressedCopy).sort()).toEqual([
      "Editor-abc.js.br",
      "codec-abc.wasm.br",
      "editor-abc.css.br",
    ]);
    for (const name of compressed) {
      const copy = await readFile(join(dir, `${name}.br`));
      expect(copy.byteLength).toBeLessThan(files[name].length);
      expect(brotliDecompressSync(copy).toString()).toBe(files[name]);
    }
  });

  it("does nothing when the build wrote no assets directory", async () => {
    await expect(precompressAssets(join(tmpdir(), "precompress-missing-dir"))).resolves.toEqual([]);
  });
});

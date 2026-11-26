// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { precompressedContentType } from "../src/shared/precompressedAssets";
import { PYODIDE_RUNTIME_FILES, pyodideIndexPath, pyodideRuntimeFile } from "./pyodideAssetsPlugin";

const installedVersion = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../node_modules/pyodide/package.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string }
).version;

describe("where the app serves the Python interpreter", () => {
  // The Worker caches everything under /assets for a year, so a path must
  // never come to mean other bytes: an upgrade has to move the interpreter.
  it("is under the build's assets, named by the installed version", () => {
    expect(pyodideIndexPath()).toBe(`/assets/pyodide-${installedVersion}/`);
    expect(pyodideIndexPath("static")).toBe(`/static/pyodide-${installedVersion}/`);
  });
});

describe("the interpreter's files", () => {
  const indexPath = "/assets/pyodide-1.2.3/";

  // A Pyodide release that renames one of these would otherwise build clean
  // and fail at the first Run.
  it("are all in the installed package", () => {
    for (const name of Object.keys(PYODIDE_RUNTIME_FILES)) {
      const file = pyodideRuntimeFile(`${indexPath}${name}`, indexPath);
      expect(file).not.toBeNull();
      expect(existsSync(file!)).toBe(true);
    }
  });

  it("answer the WebAssembly module with the type a browser compiles as it downloads", () => {
    expect(PYODIDE_RUNTIME_FILES["pyodide.asm.wasm"]).toBe("application/wasm");
  });

  // The build emits a Brotli copy of each of these; the Worker serves one only
  // for a type src/shared/precompressedAssets.ts lists, with that type.
  it("get a Brotli copy exactly where the Worker would serve one, under the same type", () => {
    const compressed = Object.keys(PYODIDE_RUNTIME_FILES).filter(precompressedContentType);
    expect(compressed.sort()).toEqual(["pyodide-lock.json", "pyodide.asm.mjs", "pyodide.asm.wasm"]);
    for (const name of compressed) {
      expect(precompressedContentType(name)).toBe(PYODIDE_RUNTIME_FILES[name]);
    }
  });
});

describe("a request to the index path", () => {
  const indexPath = "/assets/pyodide-1.2.3/";
  const resolve = (pathname: string) => pyodideRuntimeFile(pathname, indexPath);

  it("resolves nothing but the interpreter's four files", () => {
    expect(resolve("/assets/pyodide-1.2.3/package.json")).toBeNull();
    expect(resolve("/assets/pyodide-1.2.3/pyodide.mjs")).toBeNull();
    expect(resolve("/assets/pyodide-1.2.3/../pyodide/pyodide.asm.wasm")).toBeNull();
    expect(resolve("/assets/pyodide-1.2.3/%2E%2E/package.json")).toBeNull();
    expect(resolve("/assets/pyodide-1.2.3/constructor")).toBeNull();
    expect(resolve("/assets/pyodide-9.9.9/pyodide.asm.wasm")).toBeNull();
    expect(resolve("/pyodide.asm.wasm")).toBeNull();
  });
});

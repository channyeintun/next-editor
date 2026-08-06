import { describe, expect, it } from "vitest";

import { isWorkspaceTextFile, lessonRunsInWebContainer } from "../types/workspace";
import { createStarterKiteWebWorkspace } from "./kiteWeb";

/**
 * What is particular to the web starter: that it runs in the WebContainer,
 * that it brings a compiler with it, and that its logic is Kite rather than
 * JavaScript.
 *
 * Its Kite is compiled and format-checked by `kitePrograms.test.ts`, which
 * does that for every starter — the web starter had such a test while the
 * console starter did not, and the console starter was the one that broke.
 */

function textFile(project: ReturnType<typeof createStarterKiteWebWorkspace>, path: string) {
  const file = project.files[path];
  expect(file, `${path} is missing from the starter`).toBeDefined();
  if (!isWorkspaceTextFile(file)) throw new Error(`${path} is not a text file`);
  return file.content;
}

describe("kite web starter", () => {
  const project = createStarterKiteWebWorkspace();

  it("runs in the WebContainer and previews", () => {
    expect(lessonRunsInWebContainer(project.lessonType)).toBe(true);
  });

  it("installs a compiler rather than expecting one", () => {
    // The WebContainer runs no native code, so the toolchain has to arrive
    // through npm as WebAssembly. A starter that assumed `kitec` on the PATH
    // would install cleanly and then fail at the first `.kite` import.
    const manifest = JSON.parse(textFile(project, "package.json"));
    expect(manifest.devDependencies).toHaveProperty("@kite-lang/compiler-wasm");
    expect(manifest.devDependencies).toHaveProperty("vite-plugin-kite");
  });

  it("keeps JavaScript out of src/", () => {
    // The point of the starter is that the page's logic is Kite, not Kite
    // doing arithmetic while JavaScript drives the DOM.
    const stray = Object.keys(project.files).filter(
      (path) => path.startsWith("src/") && (path.endsWith(".js") || path.endsWith(".ts")),
    );
    expect(stray).toEqual([]);
  });
});

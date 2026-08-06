import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { instantiateKiteCompiler, type KiteCompiler } from "../runtime/kitePlayground/compiler";
import { isWorkspaceTextFile, lessonRunsInWebContainer } from "../types/workspace";
import { createStarterKiteWebWorkspace } from "./kiteWeb";

/**
 * The Kite web starter carries a program copied from the Kite repository's
 * own Vite starter, and no cross-repository test can watch that copy for rot.
 * What can be checked is the thing that actually matters: that the program
 * still compiles — using the compiler this app already ships, which is the
 * same compiler the starter installs from npm.
 *
 * Without this, a starter whose Kite no longer compiles would install, boot a
 * dev server, and fail at the first import, with nothing red until a learner
 * hit it.
 */

const wasmPath = resolve(process.cwd(), "src/core/kite/build/kite-compiler.wasm");

function textFile(project: ReturnType<typeof createStarterKiteWebWorkspace>, path: string) {
  const file = project.files[path];
  expect(file, `${path} is missing from the starter`).toBeDefined();
  if (!isWorkspaceTextFile(file)) throw new Error(`${path} is not a text file`);
  return file.content;
}

describe("kite web starter", () => {
  const project = createStarterKiteWebWorkspace();
  let kite: KiteCompiler;

  beforeAll(async () => {
    kite = await instantiateKiteCompiler(readFileSync(wasmPath));
  });

  it("runs in the WebContainer and previews", () => {
    expect(lessonRunsInWebContainer(project.lessonType)).toBe(true);
  });

  it("compiles both of its page programs", () => {
    // A Kite module is a directory, so each entry is checked with its
    // siblings — `main.kite` says `use checkout`.
    const main = textFile(project, "src/main.kite");
    const about = textFile(project, "src/about.kite");
    const checkout = textFile(project, "src/checkout.kite");

    expect(kite.checkModule(main, { checkout, about }), "src/main.kite does not compile").toBe("");
    expect(kite.checkModule(about, { checkout, main }), "src/about.kite does not compile").toBe("");
  });

  it("is already formatted, so Format moves nothing", () => {
    for (const path of ["src/main.kite", "src/about.kite", "src/checkout.kite"]) {
      const source = textFile(project, path);
      expect(kite.format(source), `${path} is not formatted`).toBe(source);
    }
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

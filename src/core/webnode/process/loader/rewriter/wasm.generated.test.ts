// @vitest-environment node
// The committed module (wasm.generated.ts) is built by hand, with
// `bun run build:webnode-rewriter`; nothing rebuilds it in a deploy. These
// tests fail when it no longer matches the source it is said to be built from.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REWRITER_SOURCE_FILES,
  REWRITER_SOURCE_HASH,
  REWRITER_WASM_BASE64,
} from "./wasm.generated";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Every Rust file under `directory`, relative to this directory. */
function rustFiles(directory: string): string[] {
  return readdirSync(here(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return rustFiles(path);
    }
    return entry.name.endsWith(".rs") ? [path] : [];
  });
}

describe("the committed rewriter module", () => {
  it("was built from the Rust source and the dependencies as they are now", () => {
    // Fails after an edit to the crate without `bun run build:webnode-rewriter`.
    const hash = createHash("sha256");
    for (const file of REWRITER_SOURCE_FILES) {
      hash.update(file);
      hash.update("\0");
      hash.update(readFileSync(here(file)));
      hash.update("\0");
    }
    expect(hash.digest("hex")).toBe(REWRITER_SOURCE_HASH);
  });

  it("was built from every Rust file of the crate, its manifest and its lock", () => {
    expect([...REWRITER_SOURCE_FILES].sort()).toEqual(
      ["crate/Cargo.toml", "crate/Cargo.lock", ...rustFiles("crate/src")].sort(),
    );
  });

  it("is a module that needs nothing from outside and offers the rewriter's calls", () => {
    const module = new WebAssembly.Module(Buffer.from(REWRITER_WASM_BASE64, "base64"));
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const offered = WebAssembly.Module.exports(module).map((entry) => entry.name);
    expect(offered).toEqual(
      expect.arrayContaining([
        "memory",
        "wnr_alloc",
        "wnr_rewrite",
        "wnr_result_ptr",
        "wnr_result_len",
        "wnr_release",
      ]),
    );
  });
});

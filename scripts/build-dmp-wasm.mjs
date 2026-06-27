// Builds the diff-match-patch codec (src/core/dmp, Rust) to the committed,
// zero-import WebAssembly artifact at src/core/dmp/build/next-editor-dmp.wasm.
//
//   bun run build:wasm
//
// Two stages: `cargo build` (LLVM, opt-level=3 + LTO) then `wasm-opt` (Binaryen)
// to shrink. The .wasm is committed (~6.5 KB) so tests and Vercel need no Rust
// toolchain; only regenerating it does. Requires the wasm32-unknown-unknown
// target (`rustup target add wasm32-unknown-unknown`) and `wasm-opt` (Binaryen).
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = resolve(root, "src/core/dmp");
const rawWasm = resolve(crateDir, "target/wasm32-unknown-unknown/release/next_editor_dmp.wasm");
const outWasm = resolve(crateDir, "build/next-editor-dmp.wasm");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

try {
  run("cargo", [
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    resolve(crateDir, "Cargo.toml"),
  ]);
} catch {
  console.error(
    "\ncargo build failed. Install Rust (https://rustup.rs) and the wasm target:\n" +
      "  rustup target add wasm32-unknown-unknown\n",
  );
  process.exit(1);
}

mkdirSync(dirname(outWasm), { recursive: true });

try {
  // `-all` enables the post-MVP features rustc emits (sign-ext, etc.); `-O3`
  // optimizes for speed. The result stays zero-import.
  run("wasm-opt", ["-all", "-O3", "-o", outWasm, rawWasm]);
} catch {
  console.error(
    "\nwasm-opt not found or failed. Install Binaryen (e.g. `brew install binaryen`).\n",
  );
  process.exit(1);
}

console.log(`\nbuilt ${outWasm} (${statSync(outWasm).size} bytes)`);

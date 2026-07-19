// Builds the extension and packages a VSIX into .artifacts/.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(extensionRoot, "package.json"), "utf8"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: extensionRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

mkdirSync(path.join(extensionRoot, ".artifacts"), { recursive: true });

// The dev-only benchmark bundle must never ship (ADR 0002); vsce's
// re-exclusion after a `!dist/**` whitelist is unreliable, so remove it.
rmSync(path.join(extensionRoot, "dist", "benchmark"), {
  recursive: true,
  force: true,
});

const vsce = path.join(extensionRoot, "node_modules", ".bin", "vsce");
const outFile = path.join(".artifacts", `${packageJson.name}-${packageJson.version}.vsix`);
// vscode:prepublish runs the full build; --no-dependencies because both
// bundles are self-contained (esbuild + vite).
run(vsce, ["package", "--no-dependencies", "-o", outFile]);
console.log(`VSIX written to ${outFile}`);

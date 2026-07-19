// Builds the benchmark bundle and runs it inside an Extension Development
// Host, writing .artifacts/renderer-benchmark.json (plan §11.3).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: extensionRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

const vite = path.join(extensionRoot, "node_modules", ".bin", "vite");
const tsc = path.join(extensionRoot, "node_modules", ".bin", "tsc");

run(vite, ["build", "--config", "vite.benchmark.config.ts"]);
run(tsc, ["-p", "tsconfig.test.json"]);
run("node", [path.join("dist-test", "benchmark", "launch.js")]);

// Bundles and runs the TypeScript fixture generator (plan §21.4).
import { builtinModules, createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const nodeResolveBare = {
  name: "node-resolve-bare",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("node:") || builtinModules.includes(args.path)) {
        return { external: true, path: args.path };
      }
      try {
        return {
          path: require.resolve(args.path, {
            paths: [args.resolveDir || extensionRoot, extensionRoot],
          }),
        };
      } catch {
        return undefined;
      }
    });
  },
};

const outFile = path.join(extensionRoot, "dist-test", "generate-fixtures.cjs");
await esbuild.build({
  entryPoints: [path.join(extensionRoot, "scripts", "generate-fixtures-impl.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  plugins: [nodeResolveBare],
  logLevel: "warning",
});

const result = spawnSync("node", [outFile, ...process.argv.slice(2)], {
  cwd: extensionRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);

import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// A stale ~/.pnp.cjs on this machine makes esbuild's automatic Yarn PnP
// detection reject dependencies. Resolve bare imports with standard Node
// resolution from the importer instead (same workaround family as the
// repo's wrangler [alias] entries; do not delete the user's manifest).
const nodeResolveBare = {
  name: "node-resolve-bare",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (
        args.path === "vscode" ||
        args.path.startsWith("node:") ||
        builtinModules.includes(args.path)
      ) {
        return { external: true, path: args.path };
      }
      try {
        return {
          path: require.resolve(args.path, {
            paths: [args.resolveDir || extensionRoot, extensionRoot],
          }),
        };
      } catch {
        return undefined; // fall through to esbuild's default resolver
      }
    });
  },
};

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  plugins: [nodeResolveBare],
  sourcemap: production ? false : "linked",
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

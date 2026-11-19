import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import type { Plugin as RolldownPlugin } from "rolldown";

const require = createRequire(import.meta.url);
const ENGINE_ROOT = fileURLToPath(new URL("../src/core/webnode/", import.meta.url));

export interface WebnodeBundleOptions {
  /** The directory the three scripts are written to. */
  outDir: string;
  minify?: boolean;
  /**
   * What every script of this build calls itself (src/core/webnode/buildId.ts).
   * The scripts ask for each other by it, so a host can keep two builds apart
   * across a deploy. Left out, the scripts are unversioned.
   */
  buildId?: string;
}

/** The file, beside the scripts, that names the build they belong to. */
export const WEBNODE_BUILD_MANIFEST = "build.json";

/** The scripts the webnode runtime loads at run time, by file name in `outDir`. */
export const WEBNODE_BUNDLE_FILES = {
  /** The runtime frame's script: starts the kernel worker on the runtime origin. */
  runtime: "runtime.js",
  /** The kernel worker: filesystem, process table, preview gateway. */
  kernel: "kernel.js",
  /** The process worker: the Node runtime, the shell and the package installer. */
  process: "process.js",
  /** The service worker of a preview origin. */
  previewServiceWorker: "preview-sw.js",
  /** The worker that makes large modules' entries: the loader's rewrite and the Rust rewriter. */
  prepare: "prepare.js",
} as const;

/**
 * The bare names packages bundled into the process worker `require` for a Node
 * builtin. They must reach webnode's own modules, so a stream made by
 * readable-stream is an `EventEmitter` of the same class a program requires.
 */
function nodeBuiltinAliases(): RolldownPlugin {
  const engine = (path: string) => `${ENGINE_ROOT}${path}`;
  const aliases: Record<string, string> = {
    events: engine("process/node/events.ts"),
    buffer: require.resolve("buffer/"),
    "buffer/": require.resolve("buffer/"),
    // The bare name is the engine's module (any view as input, base64url, a
    // fresh state after end()); it wraps the package, which it imports by the
    // name with a slash.
    string_decoder: engine("process/node/string_decoder.ts"),
    "string_decoder/": require.resolve("string_decoder/"),
    "punycode/": require.resolve("punycode/"),
    process: engine("process/node/internal/processShim.ts"),
    "process/": engine("process/node/internal/processShim.ts"),
  };
  return {
    name: "webnode-node-builtin-aliases",
    resolveId(source) {
      return aliases[source] ?? null;
    },
  };
}

const SUCRASE_REQUIRE = "require('${path}')";
const SUCRASE_EXPORTS = /(?<!module\.)\bexports\b/g;
/** sucrase's files that write the generated module code, and how often each names `exports`. */
const SUCRASE_EMITTERS: Record<string, { requires: number }> = {
  "sucrase/dist/esm/CJSImportProcessor.js": { requires: 2 },
  "sucrase/dist/esm/transformers/CJSImportTransformer.js": { requires: 0 },
  "sucrase/dist/esm/HelperManager.js": { requires: 0 },
};

/**
 * sucrase rewrites `import x from "y"` into `var _y = require('y')` and
 * `export const a` into `exports.a = a`. An ES module is free to declare its own
 * `require` (`createRequire(import.meta.url)`) and `exports` (Vite's server
 * bundle has a top-level `var exports`), so the generated code uses the
 * loader's private bindings instead (STATIC_IMPORT_BINDING and EXPORTS_BINDING
 * in process/loader/transform.ts). The names appear in sucrase only inside the
 * strings it emits.
 */
function sucraseModuleBindings(): RolldownPlugin {
  return {
    name: "webnode-sucrase-module-bindings",
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      const emitter = Object.entries(SUCRASE_EMITTERS).find(([suffix]) => file.endsWith(suffix));
      if (!emitter) {
        return null;
      }
      const requires = code.split(SUCRASE_REQUIRE).length - 1;
      const exportsNames = code.match(SUCRASE_EXPORTS)?.length ?? 0;
      if (requires !== emitter[1].requires || exportsNames === 0) {
        throw new Error(
          `sucrase's module rewriting changed in ${emitter[0]}: found ${requires} require() templates and ${exportsNames} uses of "exports"`,
        );
      }
      return code
        .replaceAll(SUCRASE_REQUIRE, "__webnode_require('${path}')")
        .replace(SUCRASE_EXPORTS, "__webnode_exports");
    },
  };
}

/**
 * Names the loader's rewrite of a module (process/loader/transform.ts): the
 * prepared forms a browser keeps between visits (process/loader/preparedEntry.ts)
 * are used only by a build whose rewrite has the same name. It is a hash of
 * everything the rewritten code depends on: the rewrite's own source (which
 * imports nothing else of the engine; webnodeBundle.test.ts holds it to that),
 * the Rust rewriter as built, this file (which renames sucrase's bindings) and
 * the two packages the rewrite calls.
 * So a deploy that changes none of them keeps what its visitors' browsers hold.
 */
export function webnodeTransformId(): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(`${ENGINE_ROOT}process/loader/transform.ts`));
  hash.update(readFileSync(`${ENGINE_ROOT}process/loader/rewriter/wasm.generated.ts`));
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  for (const name of ["sucrase", "es-module-lexer"]) {
    // Not `<name>/package.json`: a package's exports need not offer it.
    const entry = require.resolve(name);
    const inside = `/node_modules/${name}/`;
    const root = entry.slice(0, entry.lastIndexOf(inside) + inside.length);
    const manifest = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version: string };
    hash.update(`${name}@${manifest.version}`);
  }
  return hash.digest("hex").slice(0, 16);
}

async function bundle(entry: string, file: string, options: WebnodeBundleOptions): Promise<void> {
  await build({
    input: `${ENGINE_ROOT}${entry}`,
    platform: "browser",
    plugins: [nodeBuiltinAliases(), sucraseModuleBindings()],
    logLevel: "warn",
    transform: {
      define: {
        __WEBNODE_BUILD_ID__: JSON.stringify(options.buildId ?? ""),
        __WEBNODE_TRANSFORM_ID__: JSON.stringify(webnodeTransformId()),
      },
    },
    output: {
      file: `${options.outDir}/${file}`,
      // Classic worker scripts: one file each, no imports.
      format: "iife",
      // The browser keeps a script that has one character outside ASCII at two
      // bytes a character, and every process is a worker with its own copy of
      // process.js: escaped, an idle process takes 12 MB instead of 15.
      charset: "ascii",
      // Node programs read `name` off functions and classes (`<Buffer 68 69>`,
      // `error.constructor.name`, `Module {}`), so neither the bundler's
      // renaming of clashing names nor the minifier may change it.
      keepNames: true,
      minify: options.minify
        ? {
            mangle: { keepNames: true },
            compress: { keepNames: { function: true, class: true } },
          }
        : false,
      codeSplitting: false,
    },
  });
}

/**
 * Builds the webnode runtime's scripts. They are served, as static files, only
 * on the runtime's own hosts; they are never part of the app's module graph.
 */
export async function buildWebnodeBundles(options: WebnodeBundleOptions): Promise<void> {
  await Promise.all([
    bundle("kernel/runtimeFrame.ts", WEBNODE_BUNDLE_FILES.runtime, options),
    bundle("kernel/kernelWorker.ts", WEBNODE_BUNDLE_FILES.kernel, options),
    bundle("process/host.ts", WEBNODE_BUNDLE_FILES.process, options),
    bundle("preview/sw.ts", WEBNODE_BUNDLE_FILES.previewServiceWorker, options),
    bundle("process/prepareHost.ts", WEBNODE_BUNDLE_FILES.prepare, options),
  ]);
}

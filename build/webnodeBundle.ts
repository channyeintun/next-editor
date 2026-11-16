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
}

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
    string_decoder: require.resolve("string_decoder/"),
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

async function bundle(entry: string, file: string, options: WebnodeBundleOptions): Promise<void> {
  await build({
    input: `${ENGINE_ROOT}${entry}`,
    platform: "browser",
    plugins: [nodeBuiltinAliases(), sucraseModuleBindings()],
    logLevel: "warn",
    output: {
      file: `${options.outDir}/${file}`,
      // Classic worker scripts: one file each, no imports.
      format: "iife",
      minify: options.minify ?? false,
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
  ]);
}

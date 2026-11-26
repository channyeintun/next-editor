import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { PRECOMPRESSED_SUFFIX, precompressedContentType } from "../src/shared/precompressedAssets";
import { brotliQuality11 } from "./precompressAssetsPlugin";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("../node_modules/pyodide/", import.meta.url));
/** Brotli copies of one installed version, kept between builds. */
const CACHE_DIRECTORY = fileURLToPath(
  new URL("../node_modules/.cache/next-editor-pyodide/", import.meta.url),
);

/**
 * What Pyodide's loader fetches from its index URL to start an interpreter,
 * each with the type a dev server answers with. The package ships more (the
 * loader itself, which is bundled; its console pages; type files): only these
 * four are ever requested.
 */
export const PYODIDE_RUNTIME_FILES: Readonly<Record<string, string>> = {
  "pyodide.asm.mjs": "text/javascript",
  // Compiled while it downloads, which a browser does only for this type.
  "pyodide.asm.wasm": "application/wasm",
  "python_stdlib.zip": "application/zip",
  "pyodide-lock.json": "application/json",
};

function installedPyodideVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, "package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Where the app serves the interpreter, as Pyodide's `indexURL` takes it. It
 * is under the build's assets directory, which the Worker caches for a year
 * (infra/worker/staticAssets.ts), so the package's version is in the path: a
 * path then always means the same bytes, as a hashed name does.
 */
export function pyodideIndexPath(assetsDir = "assets"): string {
  return `/${assetsDir}/pyodide-${installedPyodideVersion()}/`;
}

/**
 * The file on disk for a request to the index path, or null when the path is
 * not one of the interpreter's files. Only a listed name resolves, so no
 * request reaches another file of the package or of the disk.
 */
export function pyodideRuntimeFile(pathname: string, indexPath: string): string | null {
  if (!pathname.startsWith(indexPath)) return null;
  const name = pathname.slice(indexPath.length);
  return Object.hasOwn(PYODIDE_RUNTIME_FILES, name) ? join(PACKAGE_DIRECTORY, name) : null;
}

/**
 * The Brotli-11 copy of one of the interpreter's files. The WebAssembly module
 * takes about half a minute to compress, so the copy is kept under
 * node_modules/.cache, in a folder named by the installed version: a build
 * pays for it once per upgrade.
 */
async function brotliCopy(name: string, source: Buffer): Promise<Buffer> {
  const directory = join(CACHE_DIRECTORY, installedPyodideVersion());
  const cached = join(directory, `${name}${PRECOMPRESSED_SUFFIX}`);
  try {
    return await readFile(cached);
  } catch {
    const copy = await brotliQuality11(source);
    await mkdir(directory, { recursive: true });
    await writeFile(cached, copy);
    return copy;
  }
}

/**
 * Serves the Python interpreter from the app's own origin.
 *
 * A Python lesson runs on Pyodide — CPython built to WebAssembly — and its
 * loader fetches the interpreter at run time: from jsDelivr unless told
 * otherwise. Served from there, a lesson would stop running whenever a learner
 * could not reach that CDN, the dependency the in-page runners exist to avoid.
 * A build emits the files beside the app's other assets, a dev server answers
 * the same paths from node_modules, and `__PYODIDE_INDEX_URL__` tells the
 * interpreter's worker where they are
 * (src/runtime/pythonPlayground/python.worker.ts).
 *
 * build/precompressAssetsPlugin.ts compresses the files at the top of the
 * assets directory only, so the Brotli copies the Worker serves are emitted
 * here, for the types it has a copy of.
 */
export function pyodideAssetsPlugin(): Plugin {
  let indexPath = pyodideIndexPath();
  let isClientBuild = false;
  return {
    name: "next-editor-pyodide-assets",
    config(config, environment) {
      indexPath = pyodideIndexPath(config.build?.assetsDir);
      isClientBuild = environment.command === "build" && !config.build?.ssr;
      return { define: { __PYODIDE_INDEX_URL__: JSON.stringify(indexPath) } };
    },
    async buildStart() {
      if (!isClientBuild || process.env.VITEST) return;
      for (const name of Object.keys(PYODIDE_RUNTIME_FILES)) {
        const source = await readFile(join(PACKAGE_DIRECTORY, name));
        // Fixed names: the loader builds each URL from the file's own name.
        const fileName = `${indexPath.slice(1)}${name}`;
        this.emitFile({ type: "asset", fileName, source });
        if (precompressedContentType(name)) {
          this.emitFile({
            type: "asset",
            fileName: `${fileName}${PRECOMPRESSED_SUFFIX}`,
            source: await brotliCopy(name, source),
          });
        }
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const { pathname } = new URL(request.url ?? "/", "http://internal");
        const file = pyodideRuntimeFile(pathname, indexPath);
        if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
          next();
          return;
        }
        response.writeHead(200, {
          "Content-Type": PYODIDE_RUNTIME_FILES[pathname.slice(indexPath.length)],
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        createReadStream(file).pipe(response);
      });
    },
  };
}

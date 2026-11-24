import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const PACKAGE_DIRECTORY = fileURLToPath(
  new URL("../node_modules/@excalidraw/excalidraw/", import.meta.url),
);
/** The folder Excalidraw asks an asset path for: `<asset path>fonts/<family>/<file>`. */
const FONTS_FOLDER = "fonts";
const FONTS_DIRECTORY = join(PACKAGE_DIRECTORY, "dist/prod", FONTS_FOLDER);

function installedExcalidrawVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, "package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Where the app serves Excalidraw's assets, as `window.EXCALIDRAW_ASSET_PATH`
 * takes it. It is under the build's assets directory, which the Worker caches
 * for a year (infra/worker/staticAssets.ts), so the package's version is in the
 * path: a path then always means the same bytes, as a hashed name does.
 */
export function excalidrawAssetPath(assetsDir = "assets"): string {
  return `/${assetsDir}/excalidraw-${installedExcalidrawVersion()}/`;
}

/** Every font file Excalidraw ships, as `<family>/<file>` under its fonts folder. */
export function excalidrawFontFiles(): string[] {
  return readdirSync(FONTS_DIRECTORY, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(FONTS_DIRECTORY.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
}

/**
 * The file on disk for a request to the asset path, or null when the path is
 * not one of Excalidraw's fonts. Only a listed name resolves, so no request
 * reaches a file outside the fonts folder.
 */
export function excalidrawFontFile(
  pathname: string,
  assetPath: string,
  files: ReadonlySet<string>,
): string | null {
  const prefix = `${assetPath}${FONTS_FOLDER}/`;
  if (!pathname.startsWith(prefix)) return null;
  let file: string;
  try {
    file = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return files.has(file) ? join(FONTS_DIRECTORY, file) : null;
}

/**
 * Serves Excalidraw's fonts from the app's own origin.
 *
 * Excalidraw does not bundle its fonts: it fetches each one at runtime from
 * `window.EXCALIDRAW_ASSET_PATH`, and from esm.sh when that is not set. A
 * learner who could not reach esm.sh (blocked, or slow) saw every whiteboard
 * label in the browser's default serif. A build now emits the fonts beside the
 * app's other assets, a dev server answers the same paths from node_modules,
 * and `__EXCALIDRAW_ASSET_PATH__` tells the whiteboard where they are
 * (src/utils/whiteboardFonts.ts). esm.sh stays Excalidraw's second source.
 */
export function excalidrawFontsPlugin(): Plugin {
  let assetPath = excalidrawAssetPath();
  let isClientBuild = false;
  return {
    name: "next-editor-excalidraw-fonts",
    config(config, environment) {
      assetPath = excalidrawAssetPath(config.build?.assetsDir);
      isClientBuild = environment.command === "build" && !config.build?.ssr;
      return { define: { __EXCALIDRAW_ASSET_PATH__: JSON.stringify(assetPath) } };
    },
    buildStart() {
      if (!isClientBuild || process.env.VITEST) return;
      for (const file of excalidrawFontFiles()) {
        this.emitFile({
          type: "asset",
          // Fixed names: Excalidraw builds each URL from the font's own path.
          fileName: `${assetPath.slice(1)}${FONTS_FOLDER}/${file}`,
          source: readFileSync(join(FONTS_DIRECTORY, file)),
        });
      }
    },
    configureServer(server) {
      const files = new Set(excalidrawFontFiles());
      server.middlewares.use((request, response, next) => {
        const { pathname } = new URL(request.url ?? "/", "http://internal");
        const file = excalidrawFontFile(pathname, assetPath, files);
        if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
          next();
          return;
        }
        response.writeHead(200, { "Content-Type": "font/woff2" });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        createReadStream(file).pipe(response);
      });
    },
  };
}

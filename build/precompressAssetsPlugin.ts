import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import type { Plugin } from "vite";
import { PRECOMPRESSED_SUFFIX, precompressedContentType } from "../src/shared/precompressedAssets";

const brotli = promisify(brotliCompress);

/** Brotli at its highest quality: the build pays once, every visit saves. */
export function brotliQuality11(source: Buffer): Promise<Buffer> {
  return brotli(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
    },
  });
}

// closeBundle also runs after a failed build, which may have written nothing;
// that build's own error is the one to report.
async function readAssetNames(assetsDir: string): Promise<string[]> {
  try {
    return await readdir(assetsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Writes `<file>.br` beside every file in `assetsDir` that
 * src/shared/precompressedAssets.ts lists. node:zlib's async API runs on the
 * libuv thread pool, so the files compress in parallel.
 */
export async function precompressAssets(assetsDir: string): Promise<string[]> {
  const names = (await readAssetNames(assetsDir)).filter((name) => precompressedContentType(name));
  await Promise.all(
    names.map(async (name) => {
      const path = join(assetsDir, name);
      await writeFile(
        `${path}${PRECOMPRESSED_SUFFIX}`,
        await brotliQuality11(await readFile(path)),
      );
    }),
  );
  return names;
}

/**
 * Build-only: once every other plugin has written the bundle (PostHog's
 * chunk ids included), precompress the hashed /assets for the Worker to serve.
 */
export function precompressAssetsPlugin(): Plugin {
  let assetsDir = "";
  return {
    name: "next-editor-precompress-assets",
    apply: "build",
    configResolved(config) {
      assetsDir = resolve(config.root, config.build.outDir, config.build.assetsDir);
    },
    async closeBundle() {
      const startedAt = Date.now();
      const names = await precompressAssets(assetsDir);
      this.info(`brotli-11 copies of ${names.length} assets in ${Date.now() - startedAt} ms`);
    },
  };
}

/**
 * Build-time Brotli copies of the hashed build output: the contract between
 * the build (build/precompressAssetsPlugin.ts writes them) and the Worker
 * (infra/worker/staticAssets.ts serves them).
 *
 * Every file under /assets with one of these extensions gets a quality-11
 * `<file>.br` beside it. Cloudflare otherwise compresses on the fly at a low
 * level (zstd-3 for Chrome), about 22% larger on the lesson route's JS.
 *
 * Each extension maps to the Content-Type Workers Static Assets sends for the
 * original file, which the Worker restores on the Brotli copy (the copy itself
 * would be typed as a `.br` download).
 */
const PRECOMPRESSED_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
};

export const PRECOMPRESSED_SUFFIX = ".br";

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
}

/**
 * The original Content-Type of a file the build precompresses, or undefined
 * when it has no Brotli copy (already-compressed formats, source maps).
 */
export function precompressedContentType(path: string): string | undefined {
  return PRECOMPRESSED_CONTENT_TYPES[extensionOf(path)];
}

export function isPrecompressedCopy(path: string): boolean {
  return path.endsWith(PRECOMPRESSED_SUFFIX);
}

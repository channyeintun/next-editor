// Import-time R2 ingestion of Google-hosted slide images. Instead of leaving
// every image href pointing at the live /api/proxy route (an upstream fetch
// from Google on each render), the import POSTs the image URLs to
// /api/slide-images (infra/worker/routes/slideImages.ts), which copies the
// bytes into R2 once and returns a stable key; the hrefs are then rewritten
// to /media/<key>, served straight from R2 with immutable caching.
//
// Every failure mode degrades to the proxy rewrite rather than failing the
// import: the route being absent (plain `bun run dev` without `dev:worker`),
// a signed-out user (the route requires a session), being offline, or a
// single image the route rejects (non-image content type, too large). Those
// hrefs render exactly as all pre-R2 imports do.

import { collectGoogleImageUrls, proxyHref, rewriteGoogleImageHrefs } from "./proxyImageHrefs";

// Must stay ≤ MAX_URLS_PER_REQUEST in infra/worker/routes/slideImages.ts.
// Kept small so one Worker invocation's subrequests (head + fetch + put per
// image) stay well under Cloudflare's per-request limits.
const CHUNK_SIZE = 8;

interface StoredImage {
  url: string;
  path?: string;
  error?: string;
}

async function storeChunk(urls: string[]): Promise<StoredImage[]> {
  const response = await fetch("/api/slide-images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  if (!response.ok) {
    throw new Error(`Slide image ingest failed with HTTP ${response.status}.`);
  }
  const data = (await response.json()) as { results?: StoredImage[] };
  return data.results ?? [];
}

/**
 * Rewrites Google-hosted image hrefs across all slide `svgs` (one deck import
 * = one call) to R2-backed /media/ URLs, storing each distinct image once via
 * /api/slide-images. URLs the route can't store — or all of them, if the
 * route is unreachable — fall back to /api/proxy hrefs. Returns the rewritten
 * SVGs in the same order. Makes no request at all when no slide references a
 * Google-hosted image.
 */
export async function storeImageHrefs(svgs: string[]): Promise<string[]> {
  const uniqueUrls = [...new Set(svgs.flatMap(collectGoogleImageUrls))];
  const stored = new Map<string, string>();

  if (uniqueUrls.length > 0) {
    try {
      for (let i = 0; i < uniqueUrls.length; i += CHUNK_SIZE) {
        const results = await storeChunk(uniqueUrls.slice(i, i + CHUNK_SIZE));
        for (const { url, path } of results) {
          if (path) stored.set(url, `/media/${path}`);
        }
      }
    } catch {
      // Route unreachable or a chunk hard-failed (e.g. 401 — later chunks
      // would fail the same way). Keep whatever already stored; everything
      // else falls back to the proxy rewrite below.
    }
  }

  return svgs.map((svg) =>
    rewriteGoogleImageHrefs(svg, (url) => stored.get(url) ?? proxyHref(url)),
  );
}

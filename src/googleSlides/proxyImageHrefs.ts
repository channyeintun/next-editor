// Scan/rewrite helpers for Google-hosted image hrefs inside a slide SVG.
// Google's slide-image hosts send a Cross-Origin-Resource-Policy header that
// blocks direct cross-origin loads (see src/shared/googleImageHosts.ts), so
// every such href has to be rewritten to a same-origin URL before the SVG is
// rendered. Two same-origin targets exist:
//
// - /media/slide-images/<hash> — the image's bytes copied into R2 at import
//   time (storeImageHrefs.ts + infra/worker/routes/slideImages.ts). Preferred:
//   served straight from R2 with immutable caching, no upstream fetch.
// - /api/proxy?url=<encoded original> — a live fetch from Google on every
//   render (src/shared/proxy.ts). Fallback for when the ingest route is
//   unavailable (plain `bun run dev` without the Worker, signed out, offline)
//   or rejects an image; also what all pre-R2 documents have persisted.
//
// Deliberately NOT inlined as data: URLs: that would bloat every persisted
// slide (and any lesson/recording built from it) by the image's full base64
// size. Both rewrites keep the stored SVG about the same size as the
// original. Non-matching hrefs (data: URIs, unrelated external hosts) are
// left untouched — see normalizeSvg.ts, which already leaves ordinary
// cross-origin images alone since inline SVG can load them fine.

import { isGoogleImageUrl } from "../shared/googleImageHosts";

const HREF_PATTERN = /((?:xlink:)?href\s*=\s*)(["'])([^"']*)\2/gi;

/**
 * Returns every href/xlink:href value in `svg` that points at a Google-hosted
 * image (in document order, duplicates included). Pure string scan.
 */
export function collectGoogleImageUrls(svg: string): string[] {
  const urls: string[] = [];
  for (const match of svg.matchAll(HREF_PATTERN)) {
    if (isGoogleImageUrl(match[3])) urls.push(match[3]);
  }
  return urls;
}

/**
 * Rewrites each Google-hosted image href in `svg` to `rewrite(originalUrl)`,
 * leaving all other hrefs untouched. Pure string transform; no network here.
 */
export function rewriteGoogleImageHrefs(svg: string, rewrite: (url: string) => string): string {
  return svg.replace(HREF_PATTERN, (fullMatch, prefix: string, quote: string, value: string) => {
    if (!isGoogleImageUrl(value)) return fullMatch;
    return `${prefix}${quote}${rewrite(value)}${quote}`;
  });
}

/** Same-origin live-proxy URL for `url` (see src/shared/proxy.ts). */
export function proxyHref(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

/**
 * Rewrites every Google-hosted image href in `svg` to the live /api/proxy
 * route. Fallback path — storeImageHrefs.ts is the preferred R2-backed
 * rewrite at import time.
 */
export function proxyImageHrefs(svg: string): string {
  return rewriteGoogleImageHrefs(svg, proxyHref);
}

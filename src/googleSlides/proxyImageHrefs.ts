// Rewrites Google-hosted image hrefs in a slide SVG to go through the
// transient /api/slide-image proxy (see imageProxy.ts), instead of fetching
// and inlining the bytes at import time. Google's slide-image CDN
// (docs.google.com/slides-images-rt/…) and its general image host
// (*.googleusercontent.com) send a Cross-Origin-Resource-Policy header that
// blocks direct cross-origin loads of these images — <img>, inline SVG
// <image>, and fetch() alike — even though the resources are publicly
// viewable. There is no pure-client fix, so the browser resolves these images
// through our own same-origin proxy route every time the slide is rendered.
//
// Deliberately NOT inlined as data: URLs: that would bloat every persisted
// slide (and any lesson/recording built from it) by the image's full base64
// size. Routing through the proxy keeps the stored SVG the same size as the
// original (module name + query string vs. the original absolute URL), at
// the cost of needing the proxy to be reachable whenever the slide is
// viewed — an accepted tradeoff. Non-matching hrefs (data: URIs, unrelated
// external hosts) are left untouched — see normalizeSvg.ts, which already
// leaves ordinary cross-origin images alone since inline SVG can load them
// fine without a proxy.

import { isAllowedImageHost } from "./imageProxy";

const HREF_PATTERN = /((?:xlink:)?href\s*=\s*)(["'])([^"']*)\2/gi;

function isProxyableUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    return isAllowedImageHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Scans `svg` for href/xlink:href values pointing at Google-hosted images
 * that Chrome blocks from loading cross-origin (see module doc comment
 * above), and rewrites each to `/api/slide-image?url=<encoded original>` so
 * the browser resolves it same-origin at render time. Pure string transform;
 * no network access here.
 */
export function proxyImageHrefs(svg: string): string {
  return svg.replace(HREF_PATTERN, (fullMatch, prefix: string, quote: string, value: string) => {
    if (!isProxyableUrl(value)) return fullMatch;
    const proxied = `/api/slide-image?url=${encodeURIComponent(value)}`;
    return `${prefix}${quote}${proxied}${quote}`;
  });
}

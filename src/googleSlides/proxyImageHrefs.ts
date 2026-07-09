// Rewrites Google-hosted image hrefs in a slide SVG to go through the
// transient /api/proxy route (see src/shared/proxy.ts), instead of fetching
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
//
// This host check is about *which hrefs need proxying* (known
// CORP-header-sending Google hosts), which is a narrower and separate
// concern from /api/proxy's own request validation (src/shared/proxy.ts) —
// that route now accepts any public https host, not just these.

const GOOGLE_IMAGE_HOST_SUFFIX = ".googleusercontent.com";

function isGoogleImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "docs.google.com" ||
    host === "googleusercontent.com" ||
    host.endsWith(GOOGLE_IMAGE_HOST_SUFFIX)
  );
}

const HREF_PATTERN = /((?:xlink:)?href\s*=\s*)(["'])([^"']*)\2/gi;

function isProxyableUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    return isGoogleImageHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Scans `svg` for href/xlink:href values pointing at Google-hosted images
 * that Chrome blocks from loading cross-origin (see module doc comment
 * above), and rewrites each to `/api/proxy?url=<encoded original>` so the
 * browser resolves it same-origin at render time. Pure string transform; no
 * network access here.
 */
export function proxyImageHrefs(svg: string): string {
  return svg.replace(HREF_PATTERN, (fullMatch, prefix: string, quote: string, value: string) => {
    if (!isProxyableUrl(value)) return fullMatch;
    const proxied = `/api/proxy?url=${encodeURIComponent(value)}`;
    return `${prefix}${quote}${proxied}${quote}`;
  });
}

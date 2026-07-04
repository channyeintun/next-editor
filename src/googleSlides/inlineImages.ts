// Inlines Google-hosted images referenced by a slide SVG into self-contained
// data: URLs, once, at import time. Google's slide-image CDN
// (docs.google.com/slides-images-rt/…) and its general image host
// (*.googleusercontent.com) send a Cross-Origin-Resource-Policy header that
// blocks direct cross-origin loads of these images — <img>, inline SVG
// <image>, and fetch() alike — even though the resources are publicly
// viewable. There is no pure-client fix, so matching hrefs are routed through
// the transient /api/slide-image proxy (see imageProxy.ts) and the resulting
// bytes are inlined as data: URLs directly into the stored SVG, so an
// imported slide never depends on a live network fetch again. Non-matching
// hrefs (data: URIs, unrelated external hosts) are left untouched — see
// normalizeSvg.ts, which already leaves ordinary cross-origin images alone
// since inline SVG can load them fine.

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

async function fetchAsDataUrl(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(`/api/slide-image?url=${encodeURIComponent(url)}`);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/**
 * Scans `svg` for href/xlink:href values pointing at Google-hosted images
 * that Chrome blocks from loading cross-origin (see module doc comment above),
 * fetches each one (deduped) through the transient image proxy, and replaces
 * every occurrence with a `data:` URL. Resilient to partial failure: if an
 * individual image fails to fetch or convert, its href is left unchanged (so
 * the rest of the slide still renders) instead of throwing.
 */
export async function inlineProxiedImages(svg: string): Promise<string> {
  const urls = new Set<string>();
  for (const match of svg.matchAll(HREF_PATTERN)) {
    const value = match[3];
    if (isProxyableUrl(value)) urls.add(value);
  }
  if (urls.size === 0) return svg;

  const replacements = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      const dataUrl = await fetchAsDataUrl(url);
      if (dataUrl) replacements.set(url, dataUrl);
    }),
  );
  if (replacements.size === 0) return svg;

  return svg.replace(HREF_PATTERN, (fullMatch, prefix: string, quote: string, value: string) => {
    const replacement = replacements.get(value);
    return replacement ? `${prefix}${quote}${replacement}${quote}` : fullMatch;
  });
}

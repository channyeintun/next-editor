// String-level normalization of a slide SVG extracted from a published Google
// Slides page. No DOM: this must run in tests and workers. See
// google-slide-research.md §1.4.

const GOOGLE_REDIRECT_PREFIX = "https://www.google.com/url?q=";

/**
 * Unwraps a Google hyperlink redirect wrapper
 * (https://www.google.com/url?q=<real>&…) back to its target URL. Non-wrapper
 * values are returned unchanged.
 */
function unwrapGoogleRedirect(href: string): string {
  if (!href.startsWith(GOOGLE_REDIRECT_PREFIX)) return href;
  const query = href.slice(GOOGLE_REDIRECT_PREFIX.length);
  const q = query.split("&", 1)[0];
  try {
    return decodeURIComponent(q);
  } catch {
    return href;
  }
}

/**
 * Prepares a raw slide SVG for inline injection into the DOM:
 *  - strips `tabindex` attributes (Google adds many for its own player);
 *  - unwraps `xlink:href` / `href` Google redirect wrappers to real URLs
 *    (data: URIs and ordinary URLs are left as-is — inline SVG can load
 *    cross-origin images);
 *  - defense-in-depth: removes `<script>` elements and inline `on*` event
 *    handler attributes, since the markup is dropped into our page verbatim.
 */
export function normalizeSvg(svg: string): string {
  let out = svg;

  // Drop <script>…</script> blocks and self-closing script tags.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<script\b[^>]*\/>/gi, "");

  // Remove inline event-handler attributes (on… = "…" / '…' / bare).
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Strip tabindex attributes.
  out = out.replace(/\stabindex\s*=\s*("[^"]*"|'[^']*'|-?\d+)/gi, "");

  // Unwrap Google redirect wrappers in href / xlink:href attributes.
  out = out.replace(
    /((?:xlink:)?href\s*=\s*)"([^"]*)"/gi,
    (_match, prefix: string, value: string) => `${prefix}"${unwrapGoogleRedirect(value)}"`,
  );
  out = out.replace(
    /((?:xlink:)?href\s*=\s*)'([^']*)'/gi,
    (_match, prefix: string, value: string) => `${prefix}'${unwrapGoogleRedirect(value)}'`,
  );

  return out;
}

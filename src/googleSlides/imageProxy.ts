// Shared core for the image-fetch proxy used to render Google Slides images.
// Google's slide-image CDN (docs.google.com/slides-images-rt/…) and its
// general image host (*.googleusercontent.com) send a
// Cross-Origin-Resource-Policy header that blocks direct cross-origin
// <img>/<image>/fetch() loads from the browser, even though the resources are
// publicly viewable. There is no pure-client workaround, so imported slides'
// SVGs have these hrefs rewritten to route through this proxy (see
// proxyImageHrefs.ts), which fetches the bytes server-side and hands them
// back same-origin. This runs live, at render time, on every view — the
// original image bytes are deliberately not stored, to keep persisted slide
// content small.
//
// This module is imported by both the Vite dev-server middleware
// (tube/vite/slideImageProxyPlugin.ts) and the Vercel Edge Function
// (api/slide-image.ts) so the validation/fetch logic is written once. It only
// uses the Web-standard fetch/Request/Response APIs, available in both.

const ALLOWED_EXACT_HOSTS = new Set(["docs.google.com"]);
const ALLOWED_SUFFIX = ".googleusercontent.com";

/**
 * True if `hostname` is allowed to be proxied: exactly docs.google.com, or
 * googleusercontent.com / any subdomain of it. Uses an exact-match/suffix
 * check (not `includes`) so a hostname like "googleusercontent.com.evil.com"
 * is correctly rejected.
 */
export function isAllowedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    ALLOWED_EXACT_HOSTS.has(host) ||
    host === "googleusercontent.com" ||
    host.endsWith(ALLOWED_SUFFIX)
  );
}

export interface ProxyResult {
  status: number;
  body?: ArrayBuffer;
  contentType?: string;
  error?: string;
}

/**
 * Validates and performs the proxied image fetch. Returns a plain result
 * object (not a Response) so both the Vite middleware and the Edge Function
 * can adapt it to their own response type.
 */
export async function proxySlideImage(rawUrl: string | null): Promise<ProxyResult> {
  if (!rawUrl) {
    return { status: 400, error: "Missing required 'url' query parameter." };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 400, error: "Invalid 'url' query parameter." };
  }

  if (url.protocol !== "https:") {
    return { status: 400, error: "Only https: URLs may be proxied." };
  }
  if (!isAllowedImageHost(url.hostname)) {
    return { status: 400, error: `Host '${url.hostname}' is not allowed.` };
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), { redirect: "follow" });
  } catch (cause) {
    return { status: 502, error: `Upstream fetch failed: ${String(cause)}` };
  }

  // Defense in depth: if the fetch followed a redirect off-allowlist, reject
  // the final response even though the request itself targeted an allowed host.
  let finalHostname: string;
  try {
    finalHostname = new URL(response.url).hostname;
  } catch {
    finalHostname = url.hostname;
  }
  if (!isAllowedImageHost(finalHostname)) {
    return { status: 400, error: `Redirected to a disallowed host '${finalHostname}'.` };
  }

  if (!response.ok) {
    return { status: 502, error: `Upstream responded with HTTP ${response.status}.` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return { status: 400, error: `Upstream content-type '${contentType}' is not an image.` };
  }

  const body = await response.arrayBuffer();
  return { status: 200, body, contentType };
}

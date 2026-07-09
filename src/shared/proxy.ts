// Generic same-origin fetch proxy. Originally built just for Google Slides
// images (whose CDN sends a Cross-Origin-Resource-Policy header that the
// app's COEP:require-corp blocks from a direct <img>/fetch()), it now backs
// any "fetch this URL server-side and hand back the bytes same-origin" need
// — e.g. Google avatar images hit the same COEP problem. The original bytes
// are deliberately not stored; this runs live, at render time, on every call.
//
// This module is imported by both the Vite dev-server middleware
// (tube/vite/proxyPlugin.ts) and the Cloudflare Worker route
// (infra/worker/routes/proxy.ts) so the validation/fetch logic is written
// once. It only uses the Web-standard fetch/Request/Response APIs, available
// in both.
//
// The route this backs is public and unauthenticated, and proxies arbitrary
// https URLs (no host allowlist) — so it must never be allowed to reach
// private/internal network state. isPubliclyRoutableHost blocks loopback,
// private, and link-local hosts as a baseline SSRF guard.

const BLOCKED_HOSTS = new Set(["localhost"]);

/**
 * True if `hostname` is not an obvious loopback/private/link-local address.
 * This is not a full SSRF defense (it doesn't resolve DNS to catch hostnames
 * that merely point at a private IP), just a baseline check against the
 * common cases of someone passing a literal internal address.
 */
export function isPubliclyRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (host.endsWith(".local")) return false;

  // IPv4 literal checks.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return false; // loopback
    if (a === 10) return false; // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 169 && b === 254) return false; // link-local
    if (a === 0) return false;
    return true;
  }

  // IPv6 loopback/link-local/unique-local literals.
  if (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return false;
  }

  return true;
}

export interface ProxyResult {
  status: number;
  body?: ArrayBuffer;
  contentType?: string;
  error?: string;
}

/**
 * Validates and performs the proxied fetch. Returns a plain result object
 * (not a Response) so both the Vite middleware and the Worker route can
 * adapt it to their own response type.
 */
export async function proxyUrl(rawUrl: string | null): Promise<ProxyResult> {
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
  if (!isPubliclyRoutableHost(url.hostname)) {
    return { status: 400, error: `Host '${url.hostname}' is not allowed.` };
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), { redirect: "follow" });
  } catch (cause) {
    return { status: 502, error: `Upstream fetch failed: ${String(cause)}` };
  }

  // Defense in depth: if the fetch followed a redirect into private network
  // space, reject the final response even though the request itself targeted
  // a publicly routable host.
  let finalHostname: string;
  try {
    finalHostname = new URL(response.url).hostname;
  } catch {
    finalHostname = url.hostname;
  }
  if (!isPubliclyRoutableHost(finalHostname)) {
    return { status: 400, error: `Redirected to a disallowed host '${finalHostname}'.` };
  }

  if (!response.ok) {
    return { status: 502, error: `Upstream responded with HTTP ${response.status}.` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.arrayBuffer();
  return { status: 200, body, contentType };
}

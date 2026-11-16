import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

// The local `wrangler dev` listener (`bun run dev:worker`, port 8787) answers
// any Host: neither Wrangler nor Miniflare checks it outside /cdn-cgi/. A page
// the developer visits can rebind its own name to 127.0.0.1 and make
// same-origin, readable requests to the anonymous routes, /api/proxy above
// all, whose egress there is the developer's own loopback and LAN. Browsers
// send the page's own name as Host, so refusing every name but the ones a
// developer actually browses with closes that path (the same defence Vite's
// host validation gives :5173).
//
// This only works because dev:worker runs wrangler dev with
// --infer-origin-from-routes=false (package.json). By default wrangler dev
// rewrites every request to the first route's origin, http://nexteditor.dev,
// before the Worker runs, so a rebinding Host would arrive as the PUBLIC_URL
// host and pass.
//
// Plaintext is where rebinding lives: over https the browser refuses the local
// listener's certificate for the attacker's name.
//
// Over https the same rule keeps the app to its own name. A deployment may
// route more hostnames to this Worker than the PUBLIC_URL host (the wildcard
// route of the webnode hosts, webnodePreviewHost.ts). The app, its API and its
// cookies are served on the PUBLIC_URL host only: any other name would be a
// second origin for the whole app, under a certificate that covers it.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function publicHostname(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).hostname;
  } catch {
    return null;
  }
}

/** Whether a request may be served under the Host it names. */
export function isAllowedRequestHost(requestUrl: URL, publicUrl: string | undefined): boolean {
  const publicHost = publicHostname(publicUrl);
  if (LOOPBACK_HOSTNAMES.has(requestUrl.hostname) || requestUrl.hostname === publicHost) {
    return true;
  }
  // With no PUBLIC_URL there is no name to hold an https request to.
  return requestUrl.protocol !== "http:" && publicHost === null;
}

/** Refuses a request whose Host is not the PUBLIC_URL host or a loopback name. */
export const requestHostGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (isAllowedRequestHost(new URL(c.req.url), c.env?.PUBLIC_URL)) return next();
  return c.text("Blocked request. This host is not allowed.", 403);
};

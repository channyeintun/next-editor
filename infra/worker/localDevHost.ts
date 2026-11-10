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
// Only plaintext requests are checked. Rebinding needs plaintext: over https
// the browser refuses the local listener's certificate for the attacker's
// name. Production is unchanged: it serves only the PUBLIC_URL host (the
// custom domain; workers.dev is off), which this allows, and its https traffic
// is never inspected.

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
  if (requestUrl.protocol !== "http:") return true;
  return (
    LOOPBACK_HOSTNAMES.has(requestUrl.hostname) || requestUrl.hostname === publicHostname(publicUrl)
  );
}

/** Refuses a plaintext request whose Host is not the PUBLIC_URL host or a loopback name. */
export const localDevHostGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (isAllowedRequestHost(new URL(c.req.url), c.env?.PUBLIC_URL)) return next();
  return c.text("Blocked request. This host is not allowed.", 403);
};

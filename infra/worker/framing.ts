import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

// Who may show the app's pages in a frame.
//
// Any site may embed a lesson (`/learn/<slug>?embed=true`, src/utils/embed.ts):
// a frame on another site gets no session cookie (SameSite=Lax), so the lesson
// it shows is signed out. A frame on another origin of THIS site is different.
// The webnode hosts are subdomains of the editor's domain and run lesson code
// (webnodePreviewHost.ts); a page there that framed the editor would get the
// visitor's cookie with it, and could lay its own buttons over a signed-in
// editor's controls. So a page of another origin of this site may not frame
// the app at all.

/** What `Sec-Fetch-Dest` says of a request that loads a nested page. */
const FRAME_DESTINATIONS = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

/** Whether `request` loads into a frame of a page on another origin of this site. */
export function isSameSiteFraming(request: Request): boolean {
  return (
    request.headers.get("Sec-Fetch-Site") === "same-site" &&
    FRAME_DESTINATIONS.has(request.headers.get("Sec-Fetch-Dest") ?? "")
  );
}

/** Refuses a request that would show the app in a frame of another origin of this site. */
export const sameSiteFramingGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (isSameSiteFraming(c.req.raw)) {
    return c.text("This page cannot be shown in a frame on another nexteditor.dev origin.", 403);
  }
  await next();
};

/** The pages other sites embed: the lesson pages, and the gallery they link back to. */
const EMBEDDABLE_PATH = /^\/learn(?:\/|$)/;

/**
 * The `Content-Security-Policy` that keeps a page of `pathname` out of other
 * origins' frames, or null for a page other sites embed. It backs up the guard
 * above in a browser that sends no `Sec-Fetch-*` headers; the embeddable pages
 * have the guard alone, since a policy cannot allow every site but this one's
 * subdomains.
 */
export function frameAncestorsPolicy(pathname: string): string | null {
  return EMBEDDABLE_PATH.test(pathname) ? null : "frame-ancestors 'self'";
}

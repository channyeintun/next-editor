import type { Env } from "./env";

/**
 * Vite's build output. Every file under it is named `<name>-<content hash>`,
 * so a name always means the same bytes: nothing else is ever written there,
 * and the build never emits HTML into it.
 */
const HASHED_ASSET_PREFIX = "/assets/";

export const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const MISSING_ASSET_CACHE_CONTROL = "no-store";

export function isHashedAssetPath(pathname: string): boolean {
  return pathname.startsWith(HASHED_ASSET_PREFIX);
}

/**
 * Cache policy for one ASSETS.fetch answer to an /assets/* request.
 *
 * Static Assets sends `max-age=0, must-revalidate` on everything, so each
 * visit revalidated the whole module graph, wave by wave, although a hashed
 * chunk can never change. A file that exists is now cached for a year.
 *
 * A name that is not there (a stale tab asking for a chunk the last deploy
 * renamed) gets the SPA fallback from ASSETS.fetch: index.html, also on a
 * conditional request. Cached for a year under a chunk's name, that HTML would
 * break the chunk until the cache expired, so it becomes an uncacheable 404.
 * The browser's import fails just as it did on the HTML's MIME type, and the
 * app's stale-chunk recovery (src/routeRecovery.ts) reloads the page.
 */
export function applyHashedAssetCachePolicy(response: Response): Response {
  if (response.headers.get("content-type")?.includes("text/html")) {
    void response.body?.cancel();
    return new Response("Not Found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": MISSING_ASSET_CACHE_CONTROL,
      },
    });
  }
  if (response.status !== 200 && response.status !== 304) return response;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", IMMUTABLE_ASSET_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The Worker's catch-all: static files, and the SPA shell for every path that
 * has none. Only /assets/* changes its cache policy.
 */
export async function serveStaticFile(env: Env, request: Request): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  return isHashedAssetPath(new URL(request.url).pathname)
    ? applyHashedAssetCachePolicy(response)
    : response;
}

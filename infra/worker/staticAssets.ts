import {
  PRECOMPRESSED_SUFFIX,
  isPrecompressedCopy,
  precompressedContentType,
} from "../../src/shared/precompressedAssets";
import type { Env } from "./env";

/**
 * Vite's build output. Every file under it is named `<name>-<content hash>`,
 * so a name always means the same bytes: nothing else is ever written there,
 * and the build never emits HTML into it. The build's Brotli copies
 * (`<name>-<hash>.js.br`, src/shared/precompressedAssets.ts) sit beside them.
 */
const HASHED_ASSET_PREFIX = "/assets/";

export const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const MISSING_ASSET_CACHE_CONTROL = "no-store";
// no-transform keeps Cloudflare from decoding the Brotli copy and compressing
// it again at its own, lower level (zstd for browsers that offer it).
export const PRECOMPRESSED_ASSET_CACHE_CONTROL = `${IMMUTABLE_ASSET_CACHE_CONTROL}, no-transform`;

export function isHashedAssetPath(pathname: string): boolean {
  return pathname.startsWith(HASHED_ASSET_PREFIX);
}

function isSpaFallback(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/html") ?? false;
}

function missingAsset(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": MISSING_ASSET_CACHE_CONTROL,
    },
  });
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
  if (isSpaFallback(response)) {
    void response.body?.cancel();
    return missingAsset();
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
 * Whether the browser takes Brotli. Cloudflare may rewrite Accept-Encoding
 * before the Worker runs and keeps the browser's own value in
 * `cf.clientAcceptEncoding`. `br;q=0` refuses it.
 */
export function acceptsBrotli(request: Request): boolean {
  const accepted = request.cf?.clientAcceptEncoding ?? request.headers.get("Accept-Encoding");
  if (typeof accepted !== "string") return false;
  return accepted.split(",").some((entry) => {
    const [coding, ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    if (coding !== "br") return false;
    const quality = params.find((param) => param.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

/**
 * The build's Brotli copy of an /assets file, as the original would be served
 * but encoded: the original's Content-Type, `Content-Encoding: br`, and the
 * copy's own validators, so a conditional request revalidates against it.
 * `encodeBody: "manual"` sends the bytes as they are; the runtime would
 * otherwise compress them again (index.ts copies the Response, which keeps
 * it). Null when the request should get the original instead: not a GET or
 * HEAD, a Range request, no Brotli in Accept-Encoding, a type the build does
 * not precompress, or no copy (ASSETS.fetch answers that with the SPA shell).
 */
export async function fetchPrecompressedAsset(
  env: Env,
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const contentType = precompressedContentType(pathname);
  if (
    contentType === undefined ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    request.headers.has("Range") ||
    !acceptsBrotli(request)
  ) {
    return null;
  }

  const copyUrl = new URL(request.url);
  copyUrl.pathname = `${pathname}${PRECOMPRESSED_SUFFIX}`;
  const copy = await env.ASSETS.fetch(new Request(copyUrl, request));
  if (isSpaFallback(copy) || (copy.status !== 200 && copy.status !== 304)) {
    void copy.body?.cancel();
    return null;
  }

  const headers = new Headers(copy.headers);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", PRECOMPRESSED_ASSET_CACHE_CONTROL);
  headers.append("Vary", "Accept-Encoding");
  if (copy.status === 200) headers.set("Content-Encoding", "br");
  return new Response(copy.body, {
    status: copy.status,
    statusText: copy.statusText,
    headers,
    encodeBody: "manual",
  });
}

/**
 * The Worker's catch-all: static files, and the SPA shell for every path that
 * has none. Under /assets it serves the Brotli copy to browsers that take it,
 * and caches hashed files for a year. A `.br` copy is never served by its own
 * name: its bytes would arrive without the Content-Encoding that decodes them.
 */
export async function serveStaticFile(env: Env, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!isHashedAssetPath(pathname)) return env.ASSETS.fetch(request);
  if (isPrecompressedCopy(pathname)) return missingAsset();

  return (
    (await fetchPrecompressedAsset(env, request, pathname)) ??
    applyHashedAssetCachePolicy(await env.ASSETS.fetch(request))
  );
}

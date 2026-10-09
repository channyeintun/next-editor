import { Hono } from "hono";
import type { Env } from "../env";
import { requestWaitUntil } from "../waitUntil";
import { LESSON_MEDIA_CONTENT_TYPES } from "../lessonMediaFiles";
import { SLIDE_IMAGE_CONTENT_TYPES } from "./slideImages";

// Mounted at /media in worker/index.ts. Serves R2 objects directly — the R2
// key is exactly the wildcard tail (e.g. request "/media/lessons/l1/l1.ne" ->
// key "lessons/l1/l1.ne"), matching the layout in
// docs/cloudflare-architecture.md. The lessons table stores the path with this
// route's prefix and no leading slash ("media/lessons/l1/l1.ne", see toMediaPath
// in routes/lessons.ts), and the client requests `/${lesson.ne}`.
//
// No ownership/published check here — a draft's media is only as private as
// its unguessable UUID-based key, same as a published lesson's (which is
// intentionally public). If draft media ever needs real access control, gate
// this route on session + lesson status instead of relying on the key alone.
export const mediaRoute = new Hono<{ Bindings: Env }>();

// Content types this route will hand to a browser as-is. Everything else is
// rewritten to application/octet-stream + Content-Disposition: attachment, so
// no stored type can turn a /media URL into a same-origin HTML document. The
// set is derived from the two writers' allow-lists, the extension map
// routes/uploads.ts stores from (lessonMediaFiles.ts) and the raster types
// routes/slideImages.ts stores, so a type either of them writes is served
// inline. Neither contains text/html, image/svg+xml, or anything else a
// browser executes script from, so those stay excluded by construction.
const RENDERABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream",
  ...Object.values(LESSON_MEDIA_CONTENT_TYPES),
  ...SLIDE_IMAGE_CONTENT_TYPES,
]);

// Hono's bare "/*" wildcard doesn't populate a "*" param (verified empirically
// against a running dev server — it came back undefined); ":key{.+}" is the
// form that actually captures the tail into c.req.param("key").
// The bucket is shared with namespaces that are NOT public. Collaboration room
// assets live at collaboration/rooms/<roomId>/assets/<sha256> and have their own
// read route (routes/collaboration.ts) which requires a session, checks room
// membership and the room's status, and serves the bytes defanged. This
// wildcard bypassed all of it and returned the same bytes to anyone — so a
// member removed from a room kept permanent unauthenticated access to every
// asset id they had seen. Allow-listing the public prefixes here means a
// namespace added to this bucket later is private by default.
const PUBLIC_KEY_PREFIXES = ["lessons/", "slide-images/"];

// Keys whose bytes never change once written:
// - slide-images/<sha256 of the source URL>: routes/slideImages.ts reuses a key
//   that already exists and never writes it again.
// - lessons/<id>/<id>-thumbnail-<ms>.<ext>: updateLessonThumbnail
//   (infra/client/upload/uploadLesson.ts) uploads every replacement under a
//   fresh timestamp instead of overwriting.
// These are served as immutable and kept in this location's cache. Everything
// else (.ne, audio, captions, the first upload's "<id>-thumbnail.<ext>") can be
// replaced in place by an upload retry or an owner edit, so it must revalidate.
// Never rewrite a key of these shapes in place (a thumbnail re-encode or
// backfill writes a new key and repoints the row): browsers would keep the old
// bytes for a year and each location until eviction. Deleting the R2 object
// does not reach those caches either; see docs/cloudflare-architecture.md for
// purging one that must disappear.
const WRITE_ONCE_KEY_RE =
  /^(?:slide-images\/[0-9a-f]{64}|lessons\/([\w-]+)\/\1-thumbnail-\d+\.(?:png|jpe?g|webp))$/;
const WRITE_ONCE_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Write-once keys are served from this location's Cache API copy when it has
// one, which skips the R2 read (~110-250 ms more than a cached file, measured
// from Singapore). Only a plain or revalidating GET qualifies: cache.match()
// answers If-None-Match itself, but would ignore If-Match/If-Unmodified-Since,
// and Range is left to R2 below. The query string is dropped from the cache key
// so it cannot multiply the entries. Null outside the Workers runtime (the
// worker tests run in Node).
function writeOnceEdgeCache(request: Request): { cache: Cache; key: string } | null {
  if (
    typeof caches === "undefined" ||
    request.method !== "GET" ||
    request.headers.has("range") ||
    request.headers.has("if-match") ||
    request.headers.has("if-unmodified-since")
  ) {
    return null;
  }
  const url = new URL(request.url);
  return {
    // Cast: the worker typecheck also loads lib.dom (through @types/jsdom),
    // whose CacheStorage has no `default`.
    cache: (caches as unknown as { default: Cache }).default,
    key: `${url.origin}${url.pathname}`,
  };
}

mediaRoute.get("/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (!key) {
    return c.json({ error: "not found" }, 404);
  }
  if (!PUBLIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return c.json({ error: "not found" }, 404);
  }

  const writeOnce = WRITE_ONCE_KEY_RE.test(key);
  const edge = writeOnce ? writeOnceEdgeCache(c.req.raw) : null;
  if (edge) {
    // A failing cache only costs the R2 read below, never the request.
    try {
      const hit = await edge.cache.match(new Request(edge.key, { headers: c.req.raw.headers }));
      if (hit) {
        return hit;
      }
    } catch (error) {
      console.error("Media edge cache read failed", { key }, error);
    }
  }

  // Handing R2 the request headers as `onlyIf` lets it evaluate the client's
  // validators (If-None-Match against the ETag set below); a failed precondition
  // comes back as the object without a body.
  const object = await c.env.BUCKET.get(key, {
    onlyIf: c.req.raw.headers,
    range: c.req.raw.headers,
  });
  if (!object) {
    return c.json({ error: "not found" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // The stored content-type is replayed to a browser on this app's own origin,
  // so a stored `text/html` would execute as first-party script on direct
  // navigation. routes/uploads.ts derives the stored type from the filename
  // extension, but this route also serves objects written by other paths
  // (collaboration assets take their MIME from the uploader's header) and
  // objects stored before that fix — so the renderable set is pinned here too.
  // Anything outside it is served as an inert download.
  //
  // `nosniff` alone is NOT sufficient and never was: it stops the browser
  // sniffing *away from* a declared type, but a declared text/html is still
  // parsed as a document. Likewise the upload extension allow-list constrains
  // the URL, not the type the browser dispatches on.
  const storedContentType = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!RENDERABLE_CONTENT_TYPES.has(storedContentType)) {
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", "attachment");
  }
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  // Imported slides render inside a sandboxed srcdoc iframe. That frame has
  // an opaque origin, so these otherwise same-origin image requests must opt
  // into cross-origin embedding to satisfy the app's COEP: require-corp.
  // /media objects are already public, and CORP does not grant script access
  // to their bytes (CORS still governs that).
  headers.set("cross-origin-resource-policy", "cross-origin");
  // Upload retries and owner edits may replace an existing key. Keep the ETag
  // available for validators, but require clients/CDNs to revalidate rather
  // than serving an obsolete recording, thumbnail, or companion track for a
  // year — except for the write-once keys above, which never change. Content-
  // Length is left to the runtime, which infers it correctly from the streamed
  // body in the 200 and 206 branches below (verified against local Miniflare).
  headers.set(
    "cache-control",
    writeOnce ? WRITE_ONCE_CACHE_CONTROL : "public, max-age=0, must-revalidate",
  );

  if (!("body" in object)) {
    // A revalidation (If-None-Match / If-Modified-Since) that failed means the
    // client's copy is current; a failed If-Match / If-Unmodified-Since means
    // the object is not the one the client asked for.
    const revalidating =
      c.req.header("if-none-match") !== undefined ||
      c.req.header("if-modified-since") !== undefined;
    return new Response(null, { status: revalidating ? 304 : 412, headers });
  }

  // R2 resolves `object.range` to the whole object (e.g. {offset: 0, length:
  // <full size>}) even for a plain request with no Range header, when `range`
  // is passed as a raw Headers object — verified empirically against local
  // Miniflare. Only treat the response as partial if the client actually sent
  // a Range header; otherwise this would 206 every request.
  if (object.range && c.req.header("range")) {
    const { offset, length } = resolveRange(object.range, object.size);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  const response = new Response(object.body, { status: 200, headers });
  if (edge) {
    const put = (async () => {
      try {
        await edge.cache.put(edge.key, response.clone());
      } catch (error) {
        console.error("Media edge cache write failed", { key }, error);
      }
    })();
    const waitUntil = requestWaitUntil(c);
    if (waitUntil) {
      waitUntil(put);
    } else {
      await put;
    }
  }
  return response;
});

// R2Range is declared as a discriminated union ({offset,length?} | {offset?,length}
// | {suffix}), but Miniflare's actual resolved object carries all three keys with
// unused ones set to `undefined` rather than omitted — verified empirically. So
// `"suffix" in range` is true even when it's unset; check values, not key presence.
function resolveRange(range: R2Range, totalSize: number): { offset: number; length: number } {
  const { offset, length, suffix } = range as {
    offset?: number;
    length?: number;
    suffix?: number;
  };
  if (offset !== undefined) {
    return { offset, length: length ?? totalSize - offset };
  }
  if (suffix !== undefined) {
    return { offset: totalSize - suffix, length: suffix };
  }
  return { offset: 0, length: length ?? totalSize };
}

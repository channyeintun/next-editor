import { Hono } from "hono";
import type { Env } from "../env";

// Mounted at /media in worker/index.ts. Serves R2 objects directly — the R2
// key is exactly the wildcard tail (e.g. request "/media/lessons/l1/l1.ne" ->
// key "lessons/l1/l1.ne"), matching the layout in
// docs/cloudflare-architecture.md and the paths stored in the lessons table
// (D1 stores "lessons/l1/l1.ne" without a leading slash; the client always
// prepends "/media/" itself — see infra/db/types.ts's lessonRowToLesson).
//
// No ownership/published check here — a draft's media is only as private as
// its unguessable UUID-based key, same as a published lesson's (which is
// intentionally public). If draft media ever needs real access control, gate
// this route on session + lesson status instead of relying on the key alone.
export const mediaRoute = new Hono<{ Bindings: Env }>();

// Content types this route will hand to a browser as-is. Everything else is
// rewritten to application/octet-stream + Content-Disposition: attachment, so
// no stored type can turn a /media URL into a same-origin HTML document. Kept
// in sync with the extension map in routes/uploads.ts plus the raster types
// routes/slideImages.ts stores. Deliberately excludes text/html, image/svg+xml,
// and anything else a browser executes script from.
const RENDERABLE_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/vtt",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

// Hono's bare "/*" wildcard doesn't populate a "*" param (verified empirically
// against a running dev server — it came back undefined); ":key{.+}" is the
// form that actually captures the tail into c.req.param("key").
mediaRoute.get("/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (!key) {
    return c.json({ error: "not found" }, 404);
  }

  const object = await c.env.BUCKET.get(key, { range: c.req.raw.headers });
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
  // year. Content-Length is left to the runtime, which infers it correctly
  // from the streamed body in both branches below (verified against local
  // Miniflare).
  headers.set("cache-control", "public, max-age=0, must-revalidate");

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

  return new Response(object.body, { status: 200, headers });
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

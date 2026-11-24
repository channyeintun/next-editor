import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import {
  isPublishedScriptId,
  PUBLISHED_SCRIPT_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_KEY,
  publishedScriptObjectKey,
} from "../../../src/studio/plans/publishedScripts";

// Mounted at /api/studio/scripts in worker/index.ts. Serves the published
// lesson scripts the studio reads instead of bundling them: an index that
// names each lesson's script, and the scripts themselves, stored under the
// SHA-256 of their bytes (src/studio/plans/publishedScripts.ts owns the paths,
// keys and shapes). Public, like /studio itself: a script is the same text as
// the YAML in the repository.
//
// The bytes are stored and served as plain text. Cloudflare compresses text
// for browsers on its own, and the studio hashes the decoded bytes either way,
// so there is no stored encoding to honour and no client to refuse.
//
// Nothing here keeps state between requests: a module-level promise of R2 I/O
// would tie one request's I/O to every later request in the isolate.
export const studioScriptsRoute = new Hono<{ Bindings: Env }>();

// The index changes on every publish, so a browser revalidates it each time;
// the ETag makes that a 304 when nothing changed.
const INDEX_CACHE_CONTROL = "no-cache";
// An object's key is the hash of its bytes, so its bytes never change.
const OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";

// A miss must not be cached: an object can be missing only for the moment
// between a publish putting it and a reader asking, and the index is missing
// only until the first publish.
function notFound(c: Context): Response {
  c.header("cache-control", "no-store");
  return c.json({ error: "not found" }, 404);
}

async function serveObject(
  c: Context<{ Bindings: Env }>,
  key: string,
  contentType: string,
  cacheControl: string,
): Promise<Response> {
  // Handing R2 the request headers as `onlyIf` lets it answer the client's
  // validators against the ETag below; a failed precondition comes back as
  // the object without a body.
  const object = await c.env.BUCKET.get(key, { onlyIf: c.req.raw.headers });
  if (!object) return notFound(c);

  // The type comes from code, not from what the publisher stored, so this
  // route never hands a browser a type it did not choose.
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": cacheControl,
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
  });

  if (!("body" in object)) {
    // A failed If-None-Match / If-Modified-Since means the client's copy is
    // current; a failed If-Match / If-Unmodified-Since means it is not the
    // object the client asked for.
    const revalidating =
      c.req.header("if-none-match") !== undefined ||
      c.req.header("if-modified-since") !== undefined;
    return new Response(null, { status: revalidating ? 304 : 412, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

studioScriptsRoute.get("/index", (c) =>
  serveObject(
    c,
    PUBLISHED_SCRIPT_INDEX_KEY,
    PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
    INDEX_CACHE_CONTROL,
  ),
);

// ":id{.+}" captures any tail, so a malformed id (slashes included) is this
// route's 404 rather than falling through to the app shell's 200.
studioScriptsRoute.get("/objects/:id{.+}", (c) => {
  const id = c.req.param("id");
  // Checked before the bucket is touched: only a well-formed id becomes a key.
  if (!isPublishedScriptId(id)) return notFound(c);
  return serveObject(
    c,
    publishedScriptObjectKey(id),
    PUBLISHED_SCRIPT_CONTENT_TYPE,
    OBJECT_CACHE_CONTROL,
  );
});

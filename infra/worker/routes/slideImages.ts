import { Hono } from "hono";
import { releaseMediaObject, reserveMediaObject } from "../../db/mediaObjects";
import type { Env } from "../env";
import { isJsonObject, readJsonWithLimit } from "../httpBody";
import { requireUser } from "../auth/requireUser";
import { chargeUserWriteBudget } from "../rateLimit";
import { proxyUrl, readProxyBody } from "../../../src/shared/proxy";
import { isGoogleImageUrl } from "../../../src/shared/googleImageHosts";
import { sha256Hex } from "../../../src/shared/sha256Hex";

// Mounted at /api/slide-images in worker/index.ts. Called once per Google
// Slides deck import
// (src/googleSlides/storeImageHrefs.ts): copies each Google-hosted slide
// image into R2 so the persisted SVG can reference /media/<key>, served from
// R2 by routes/media.ts, instead of an /api/proxy href that re-fetches from
// Google on every render.
//
// Keys are content-addressed by source URL (slide-images/<sha256(url)>), so
// the same image imported into any number of decks/lessons is stored once,
// and re-importing a deck ("Update") is a cheap head() per image: a key that
// already exists is reused, never rewritten. The URL is hashed as the URL
// parser normalizes it, without its fragment (canonicalImageUrl), since that
// is what is fetched: spelling one image's URL differently must not store it
// again.
//
// Abuse guards: requires a signed-in user (same bar as /api/uploads — a
// signed-out import falls back to proxy hrefs client-side), charges each
// request to the user's rate budget (SLIDE_IMAGE_RATE_LIMITER) and each newly
// stored image to their storage quota (db/mediaObjects.ts), only accepts
// URLs on Google's image hosts (this is slide-image ingestion, not a general
// "mirror any URL into our bucket" service), and only stores raster image
// content types. svg is deliberately excluded for the same reason as in
// lessonMediaFiles.ts: R2 objects are served back same-origin at /media/<key>,
// and an SVG can carry an inline <script>. The upstream fetch itself reuses
// proxyUrl (src/shared/proxy.ts) for its SSRF/redirect validation.
export const slideImagesRoute = new Hono<{ Bindings: Env }>();

// Kept in sync with CHUNK_SIZE in src/googleSlides/storeImageHrefs.ts; bounds
// this invocation's subrequests (head + fetch + put per image) well under
// Cloudflare's per-request limit.
const MAX_URLS_PER_REQUEST = 8;
// Room for MAX_URLS_PER_REQUEST long signed image URLs; an abuse backstop.
const MAX_REQUEST_BYTES = 64 * 1024;
// Slide images are typically well under 2 MB; this is an abuse backstop, not
// a tuned product limit.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// The raster types this route stores; routes/media.ts serves each one inline.
export const SLIDE_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/**
 * The URL that is actually fetched for `url` (a parsed Google image URL): the
 * parser's normalized form (host case, default port, dot segments, stray tabs
 * and newlines), without the fragment, which never leaves the browser.
 */
function canonicalImageUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

async function keyForUrl(url: string): Promise<string> {
  return `slide-images/${await sha256Hex(url)}`;
}

type IngestOutcome = { path: string } | { error: string };

interface IngestResult {
  url: string;
  path?: string;
  error?: string;
}

async function ingestImage(env: Env, userId: string, source: string): Promise<IngestOutcome> {
  const key = await keyForUrl(source);
  if (await env.BUCKET.head(key)) {
    return { path: key };
  }

  const result = await proxyUrl(source);
  if (result.status !== 200 || !result.body) {
    return { error: result.error ?? "Upstream fetch failed." };
  }

  const contentType = (result.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!SLIDE_IMAGE_CONTENT_TYPES.has(contentType)) {
    return { error: `Unsupported content type '${contentType}'.` };
  }
  let body: Uint8Array;
  try {
    body = await readProxyBody(result.body, MAX_IMAGE_BYTES);
  } catch {
    return { error: "Image too large." };
  }

  // Charged to whoever stores the image first. "taken" means another import
  // stored this same image meanwhile: writing it again costs nobody anything.
  const reservation = await reserveMediaObject(env.DB, key, userId, body.byteLength);
  if (reservation.kind === "over_quota") {
    return { error: "Storage quota reached." };
  }
  try {
    await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
  } catch (error) {
    if (reservation.kind === "reserved") {
      await releaseMediaObject(env.DB, key, userId, reservation.previousBytes);
    }
    throw error;
  }
  return { path: key };
}

slideImagesRoute.post("/", requireUser, async (c) => {
  const user = c.get("user");
  const limited = await chargeUserWriteBudget(
    c,
    c.env.SLIDE_IMAGE_RATE_LIMITER,
    user.id,
    "Slide image import",
  );
  if (limited) return limited;

  const read = await readJsonWithLimit(c.req.raw, MAX_REQUEST_BYTES);
  if (read.status === "too-large") {
    return c.json({ error: "request body is too large" }, 413);
  }
  if (read.status !== "ok") {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // `null` is valid JSON too, and has no properties to read.
  const urls = isJsonObject(read.value) ? read.value.urls : null;
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string")) {
    return c.json({ error: "'urls' must be a non-empty array of strings" }, 400);
  }
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return c.json({ error: `at most ${MAX_URLS_PER_REQUEST} urls per request` }, 400);
  }

  // One result per URL as sent (the client matches them by it), but one
  // ingest per image actually fetched.
  const unique = [...new Set(urls as string[])];
  const ingests = new Map<string, Promise<IngestOutcome>>();
  const results = await Promise.all(
    unique.map(async (url): Promise<IngestResult> => {
      if (!isGoogleImageUrl(url)) {
        return { url, error: "Not a Google-hosted image URL." };
      }
      const source = canonicalImageUrl(url);
      let ingest = ingests.get(source);
      if (!ingest) {
        ingest = ingestImage(c.env, user.id, source);
        ingests.set(source, ingest);
      }
      return { url, ...(await ingest) };
    }),
  );
  return c.json({ results });
});

import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { proxyUrl } from "../../../src/shared/proxy";
import { isGoogleImageUrl } from "../../../src/shared/googleImageHosts";

// Mounted at /api/slide-images in worker/index.ts (distinct from the legacy
// /api/slide-image proxy alias). Called once per Google Slides deck import
// (src/googleSlides/storeImageHrefs.ts): copies each Google-hosted slide
// image into R2 so the persisted SVG can reference /media/<key> — served
// straight from R2 with immutable caching — instead of an /api/proxy href
// that re-fetches from Google on every render.
//
// Keys are content-addressed by source URL (slide-images/<sha256(url)>), so
// the same image imported into any number of decks/lessons is stored once,
// and re-importing a deck ("Update") is a cheap head() per image. Objects are
// never mutated or deleted — same immutability assumption /media relies on
// for its cache-control (see routes/media.ts).
//
// Abuse guards: requires a signed-in user (same bar as /api/uploads — a
// signed-out import falls back to proxy hrefs client-side), only accepts
// URLs on Google's image hosts (this is slide-image ingestion, not a general
// "mirror any URL into our bucket" service), and only stores raster image
// content types. svg is deliberately excluded for the same reason as in
// routes/uploads.ts: R2 objects are served back same-origin at /media/<key>,
// and an SVG can carry an inline <script>. The upstream fetch itself reuses
// proxyUrl (src/shared/proxy.ts) for its SSRF/redirect validation.
export const slideImagesRoute = new Hono<{ Bindings: Env }>();

// Kept in sync with CHUNK_SIZE in src/googleSlides/storeImageHrefs.ts; bounds
// this invocation's subrequests (head + fetch + put per image) well under
// Cloudflare's per-request limit.
const MAX_URLS_PER_REQUEST = 8;
// Slide images are typically well under 2 MB; this is an abuse backstop, not
// a tuned product limit.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

async function keyForUrl(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `slide-images/${hex}`;
}

interface IngestResult {
  url: string;
  path?: string;
  error?: string;
}

async function ingestImage(bucket: R2Bucket, url: string): Promise<IngestResult> {
  if (!isGoogleImageUrl(url)) {
    return { url, error: "Not a Google-hosted image URL." };
  }

  const key = await keyForUrl(url);
  if (await bucket.head(key)) {
    return { url, path: key };
  }

  const result = await proxyUrl(url);
  if (result.status !== 200 || !result.body) {
    return { url, error: result.error ?? "Upstream fetch failed." };
  }

  const contentType = (result.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return { url, error: `Unsupported content type '${contentType}'.` };
  }
  if (result.body.byteLength > MAX_IMAGE_BYTES) {
    return { url, error: "Image too large." };
  }

  await bucket.put(key, result.body, { httpMetadata: { contentType } });
  return { url, path: key };
}

slideImagesRoute.post("/", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const urls = (body as { urls?: unknown }).urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string")) {
    return c.json({ error: "'urls' must be a non-empty array of strings" }, 400);
  }
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return c.json({ error: `at most ${MAX_URLS_PER_REQUEST} urls per request` }, 400);
  }

  const unique = [...new Set(urls as string[])];
  const results = await Promise.all(unique.map((url) => ingestImage(c.env.BUCKET, url)));
  return c.json({ results });
});

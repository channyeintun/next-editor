/**
 * Content-addressed per-dialog audio cache in the browser's Cache storage.
 * Keys are synthetic same-origin URLs derived from the TTS request hash, so a
 * dialog whose text/profile/lexicon is unchanged is never re-synthesized —
 * across renders and across page reloads. Storage is per-origin and private;
 * clearing site data resets it (the next render just re-synthesizes).
 */

const CACHE_NAME = "next-editor-studio-tts-v1";

/**
 * Marks a take whose synthesis hit Pocket's per-chunk frame cap, so a cache
 * hit repeats the Director's warning instead of silently replaying it.
 */
const FRAME_CAP_HEADER = "X-Studio-Tts-Frame-Cap";

function cacheUrlFor(requestHash: string): string {
  return `/__studio-tts-cache/${requestHash}.wav`;
}

function cacheAvailable(): boolean {
  return typeof caches !== "undefined";
}

export interface CachedDialogWav {
  wav: Uint8Array;
  hitFrameCap: boolean;
}

export async function getCachedDialogWav(requestHash: string): Promise<CachedDialogWav | null> {
  if (!cacheAvailable()) {
    return null;
  }
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(cacheUrlFor(requestHash));
  if (!hit) {
    return null;
  }
  return {
    wav: new Uint8Array(await hit.arrayBuffer()),
    hitFrameCap: hit.headers.get(FRAME_CAP_HEADER) === "1",
  };
}

export async function putCachedDialogWav(
  requestHash: string,
  { wav, hitFrameCap }: CachedDialogWav,
): Promise<void> {
  if (!cacheAvailable()) {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  const headers: Record<string, string> = { "Content-Type": "audio/wav" };
  if (hitFrameCap) {
    headers[FRAME_CAP_HEADER] = "1";
  }
  await cache.put(cacheUrlFor(requestHash), new Response(wav.slice() as BlobPart, { headers }));
}

/** Drop one entry, e.g. a cached take that no longer passes validation. */
export async function deleteCachedDialogWav(requestHash: string): Promise<void> {
  if (!cacheAvailable()) {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(cacheUrlFor(requestHash));
}

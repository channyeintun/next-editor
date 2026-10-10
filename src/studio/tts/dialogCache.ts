/**
 * Content-addressed per-dialog audio cache in the browser's Cache storage.
 * Keys are synthetic same-origin URLs derived from the TTS request hash, so a
 * dialog whose text/profile/lexicon is unchanged is never re-synthesized —
 * across renders and across page reloads. Storage is per-origin and private;
 * clearing site data resets it (the next render just re-synthesizes).
 *
 * The cache is an optimization only, so it never fails a render: a storage
 * error (quota exceeded, Cache storage blocked) is a miss or a no-op, reported
 * through the optional `onUnavailable` so the caller can warn about it.
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

/** Told why Cache storage failed; the operation was treated as a miss or a no-op. */
export type OnDialogCacheUnavailable = (reason: string) => void;

function reasonOf(error: unknown): string {
  // Cache storage rejects with DOMExceptions, which not every environment
  // makes Errors; a QuotaExceededError may come without a message.
  if (error instanceof Error || error instanceof DOMException) {
    return error.message || error.name;
  }
  return String(error);
}

export interface CachedDialogWav {
  wav: Uint8Array;
  hitFrameCap: boolean;
}

export async function getCachedDialogWav(
  requestHash: string,
  onUnavailable?: OnDialogCacheUnavailable,
): Promise<CachedDialogWav | null> {
  if (!cacheAvailable()) {
    return null;
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheUrlFor(requestHash));
    if (!hit) {
      return null;
    }
    return {
      wav: new Uint8Array(await hit.arrayBuffer()),
      hitFrameCap: hit.headers.get(FRAME_CAP_HEADER) === "1",
    };
  } catch (error) {
    onUnavailable?.(reasonOf(error));
    return null;
  }
}

export async function putCachedDialogWav(
  requestHash: string,
  { wav, hitFrameCap }: CachedDialogWav,
  onUnavailable?: OnDialogCacheUnavailable,
): Promise<void> {
  if (!cacheAvailable()) {
    return;
  }
  const headers: Record<string, string> = { "Content-Type": "audio/wav" };
  if (hitFrameCap) {
    headers[FRAME_CAP_HEADER] = "1";
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheUrlFor(requestHash), new Response(wav.slice() as BlobPart, { headers }));
  } catch (error) {
    onUnavailable?.(reasonOf(error));
  }
}

/** Drop one entry, e.g. a cached take that no longer passes validation. */
export async function deleteCachedDialogWav(
  requestHash: string,
  onUnavailable?: OnDialogCacheUnavailable,
): Promise<void> {
  if (!cacheAvailable()) {
    return;
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(cacheUrlFor(requestHash));
  } catch (error) {
    onUnavailable?.(reasonOf(error));
  }
}

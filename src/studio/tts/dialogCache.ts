/**
 * Content-addressed per-dialog audio cache in the browser's Cache storage.
 * Keys are synthetic same-origin URLs derived from the TTS request hash, so a
 * dialog whose text/profile/lexicon is unchanged is never re-synthesized —
 * across renders and across page reloads. Storage is per-origin and private;
 * clearing site data resets it (the next render just re-synthesizes).
 */

const CACHE_NAME = "next-editor-studio-tts-v1";

function cacheUrlFor(requestHash: string): string {
  return `/__studio-tts-cache/${requestHash}.wav`;
}

function cacheAvailable(): boolean {
  return typeof caches !== "undefined";
}

export async function getCachedDialogWav(requestHash: string): Promise<Uint8Array | null> {
  if (!cacheAvailable()) {
    return null;
  }
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(cacheUrlFor(requestHash));
  if (!hit) {
    return null;
  }
  return new Uint8Array(await hit.arrayBuffer());
}

export async function putCachedDialogWav(requestHash: string, bytes: Uint8Array): Promise<void> {
  if (!cacheAvailable()) {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    cacheUrlFor(requestHash),
    new Response(bytes.slice() as BlobPart, {
      headers: { "Content-Type": "audio/wav" },
    }),
  );
}

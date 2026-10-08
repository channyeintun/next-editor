/**
 * Decodes `blob` on an OfflineAudioContext: it opens no audio device and is not
 * subject to the autoplay policy. Never decode on the page's shared realtime context
 * (audioContext.ts); measuring a take's duration once did, on load, before any user
 * gesture.
 *
 * Decoding resamples the whole file to `sampleRate` as Float32, so the rate sets the
 * memory cost: each caller picks the lowest rate its use can live with.
 */
export async function decodeAudioBlob(blob: Blob, sampleRate: number): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(1, 1, sampleRate);
  return context.decodeAudioData(await blob.arrayBuffer());
}

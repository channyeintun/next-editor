// ============================================================================
// 16-bit PCM mono WAV writing: the studio stitches narration in it, and an edited
// recording falls back to it where WebCodecs cannot encode Opus.
// ============================================================================

const RIFF = 0x46464952; // "RIFF" LE
const WAVE = 0x45564157; // "WAVE" LE
const FMT_ = 0x20746d66; // "fmt " LE
const DATA = 0x61746164; // "data" LE

export function floatTo16BitPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return pcm;
}

/**
 * A zeroed 16-bit PCM mono WAV of `sampleCount` samples, with `pcm` viewing
 * its data chunk, so a writer can place samples straight into the file
 * instead of building them in a separate buffer and copying it in.
 */
export function allocateWavPcm16(
  sampleCount: number,
  sampleRate: number,
): { bytes: Uint8Array<ArrayBuffer>; pcm: Int16Array<ArrayBuffer> } {
  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  view.setUint32(0, RIFF, true);
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, WAVE, true);
  view.setUint32(12, FMT_, true);
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  view.setUint32(36, DATA, true);
  view.setUint32(40, dataBytes, true);

  return { bytes: new Uint8Array(buffer), pcm: new Int16Array(buffer, 44, sampleCount) };
}

export function encodeWavPcm16(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const wav = allocateWavPcm16(pcm.length, sampleRate);
  wav.pcm.set(pcm);
  return wav.bytes;
}

// ============================================================================
// 16-bit PCM mono WAV writing: the studio stitches narration in it, and an edited
// recording falls back to it where WebCodecs cannot encode Opus. The RIFF/WAVE
// layout lives here too, so every WAV reader shares its FourCCs and chunk walk.
// ============================================================================

export const RIFF = 0x46464952; // "RIFF" LE
export const WAVE = 0x45564157; // "WAVE" LE
export const FMT_ = 0x20746d66; // "fmt " LE
export const DATA = 0x61746164; // "data" LE

export interface RiffChunk {
  /** The chunk's FourCC as a little-endian u32, comparable with FMT_ and DATA. */
  id: number;
  /** Where the chunk's body starts in the view. */
  body: number;
  /** The body size the chunk declares, which may run past the end of the file. */
  size: number;
}

/**
 * The chunks of a RIFF/WAVE file, in order. Throws "Not a RIFF/WAVE file" when
 * the header is not one. Each chunk is reported with its declared size, so the
 * reader decides what a size past the end means (truncation, or a streamed
 * file's placeholder); the walk moves past each body and its pad byte (bodies
 * of odd size are padded to an even length) and stops when no chunk header fits.
 */
export function readRiffChunks(view: DataView): Iterable<RiffChunk> {
  if (
    view.byteLength < 12 ||
    view.getUint32(0, true) !== RIFF ||
    view.getUint32(8, true) !== WAVE
  ) {
    throw new Error("Not a RIFF/WAVE file");
  }
  return chunksAfterHeader(view);
}

function* chunksAfterHeader(view: DataView): Generator<RiffChunk> {
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const size = view.getUint32(offset + 4, true);
    yield { id: view.getUint32(offset, true), body: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
}

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

/**
 * Minimal 16-bit PCM mono WAV encode/decode/stitch — pure and
 * environment-agnostic, used by the in-page narration builder to combine
 * per-dialog synthesis into the single external-audio blob the recorder
 * expects. No compression: WAV keeps the stitch a byte-level operation and
 * every duration exact (samples / rate).
 */

const RIFF = 0x46464952; // "RIFF" LE
const WAVE = 0x45564157; // "WAVE" LE
const FMT_ = 0x20746d66; // "fmt " LE
const DATA = 0x61746164; // "data" LE

export interface TrimSilenceOptions {
  /** Absolute amplitude below which a sample counts as silence. */
  threshold?: number;
  /** Silence kept before the first voiced sample (natural onset). */
  headPadMs?: number;
  /** Silence kept after the last voiced sample (natural release). */
  tailPadMs?: number;
}

/**
 * Trim leading/trailing silence around the voiced span. pocket-tts dialogs
 * start with ~0.5s of model silence before speech onset; captions and mark
 * anchors assume speech starts at the dialog's scheduled start, so untrimmed
 * dialogs make text and actions lead the voice.
 */
export function trimSilence(
  samples: Float32Array,
  sampleRate: number,
  { threshold = 0.004, headPadMs = 40, tailPadMs = 150 }: TrimSilenceOptions = {},
): Float32Array {
  let first = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    return samples;
  }
  let last = samples.length - 1;
  for (; last > first; last--) {
    if (Math.abs(samples[last]) > threshold) {
      break;
    }
  }
  const headPad = Math.round((headPadMs / 1000) * sampleRate);
  const tailPad = Math.round((tailPadMs / 1000) * sampleRate);
  const start = Math.max(0, first - headPad);
  const end = Math.min(samples.length, last + 1 + tailPad);
  return samples.slice(start, end);
}

export function floatTo16BitPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return pcm;
}

export function encodeWavPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
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
  new Int16Array(buffer, 44).set(pcm);

  return new Uint8Array(buffer);
}

export interface DecodedWav {
  pcm: Int16Array;
  sampleRate: number;
}

export function decodeWavPcm16(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 44 ||
    view.getUint32(0, true) !== RIFF ||
    view.getUint32(8, true) !== WAVE
  ) {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm: Int16Array | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = view.getUint32(offset, true);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === FMT_) {
      const format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bitsPerSample !== 16) {
        throw new Error(
          `Unsupported WAV (need PCM16 mono): format=${format} channels=${channels} bits=${bitsPerSample}`,
        );
      }
    } else if (chunkId === DATA) {
      const sampleCount = Math.floor(chunkSize / 2);
      // Copy: the data chunk may start on an odd byte offset, and Int16Array
      // views require 2-byte alignment.
      pcm = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        pcm[i] = view.getInt16(body + i * 2, true);
      }
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!pcm || sampleRate === 0) {
    throw new Error("WAV is missing fmt or data chunk");
  }
  return { pcm, sampleRate };
}

export function wavDurationMs(bytes: Uint8Array): number {
  const { pcm, sampleRate } = decodeWavPcm16(bytes);
  return Math.round((pcm.length / sampleRate) * 1000);
}

export interface StitchSegment {
  bytes: Uint8Array;
  startMs: number;
}

/**
 * Place each segment's samples at its scheduled offset in one silent canvas.
 * Overlaps are a scheduling bug and fail loudly rather than mixing audio.
 */
export function stitchWavSegments(
  segments: readonly StitchSegment[],
  totalDurationMs: number,
  sampleRate: number,
): Uint8Array {
  const totalSamples = Math.ceil((totalDurationMs / 1000) * sampleRate);
  const canvas = new Int16Array(totalSamples);

  const placed = [...segments].sort((left, right) => left.startMs - right.startMs);
  let previousEndSample = 0;
  for (const segment of placed) {
    const decoded = decodeWavPcm16(segment.bytes);
    if (decoded.sampleRate !== sampleRate) {
      throw new Error(`Segment sample rate ${decoded.sampleRate} != stitch rate ${sampleRate}`);
    }
    const startSample = Math.round((segment.startMs / 1000) * sampleRate);
    if (startSample < previousEndSample) {
      throw new Error(`Segment at ${segment.startMs}ms overlaps the previous one`);
    }
    if (startSample + decoded.pcm.length > totalSamples) {
      throw new Error(`Segment at ${segment.startMs}ms runs past the stitched duration`);
    }
    canvas.set(decoded.pcm, startSample);
    previousEndSample = startSample + decoded.pcm.length;
  }

  return encodeWavPcm16(canvas, sampleRate);
}

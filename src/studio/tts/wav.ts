/**
 * Minimal 16-bit PCM mono WAV encode/decode/stitch — pure and
 * environment-agnostic, used by the in-page narration builder to combine
 * per-dialog synthesis into the single external-audio blob the recorder
 * expects. No compression: PCM keeps the stitch a sample-level operation and
 * every duration exact (samples / rate).
 */

// The 16-bit PCM mono writer is shared with recorded narration, so it lives in core.
import { allocateWavPcm16, encodeWavPcm16, floatTo16BitPcm } from "../../core/src/utils/wavPcm16";

const RIFF = 0x46464952; // "RIFF" LE
const WAVE = 0x45564157; // "WAVE" LE
const FMT_ = 0x20746d66; // "fmt " LE
const DATA = 0x61746164; // "data" LE

/** Absolute amplitude (of full scale) above which a sample counts as voiced. */
const VOICED_THRESHOLD = 0.004;

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
  options: TrimSilenceOptions = {},
): Float32Array {
  const span = paddedVoicedSpanOf(samples, sampleRate, 1, options);
  return span ? samples.slice(span[0], span[1]) : samples;
}

/**
 * trimSilence on 16-bit PCM, for takes that arrive as WAV: the samples are
 * sliced as they are, never round-tripped through floats (which would move
 * positive samples by one step). The threshold stays a fraction of full scale.
 * Trimming is idempotent, so trimming a trimmed take returns the same span.
 */
export function trimSilencePcm16(
  pcm: Int16Array,
  sampleRate: number,
  options: TrimSilenceOptions = {},
): Int16Array {
  const span = paddedVoicedSpanOf(pcm, sampleRate, 0x8000, options);
  return span ? pcm.slice(span[0], span[1]) : pcm;
}

/**
 * The [start, end) sample range trimSilence keeps — the voiced span widened
 * by the pads — or null when nothing is voiced. `fullScale` converts the
 * fractional threshold to the samples' units.
 */
function paddedVoicedSpanOf(
  samples: ArrayLike<number>,
  sampleRate: number,
  fullScale: number,
  { threshold = VOICED_THRESHOLD, headPadMs = 40, tailPadMs = 150 }: TrimSilenceOptions,
): [number, number] | null {
  const floor = threshold * fullScale;
  let first = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > floor) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    return null;
  }
  let last = samples.length - 1;
  for (; last > first; last--) {
    if (Math.abs(samples[last]) > floor) {
      break;
    }
  }
  const headPad = Math.round((headPadMs / 1000) * sampleRate);
  const tailPad = Math.round((tailPadMs / 1000) * sampleRate);
  return [Math.max(0, first - headPad), Math.min(samples.length, last + 1 + tailPad)];
}

export { encodeWavPcm16, floatTo16BitPcm };

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
      if (body + chunkSize > bytes.byteLength) {
        throw new Error(
          `WAV data chunk is truncated: declares ${chunkSize} bytes, ${bytes.byteLength - body} present`,
        );
      }
      const sampleCount = Math.floor(chunkSize / 2);
      // Copy into a fresh buffer: the data chunk may start on an odd byte
      // offset, and Int16Array views require 2-byte alignment. The samples are
      // little-endian, as the writer (and every supported host) assumes.
      pcm = new Int16Array(bytes.slice(body, body + sampleCount * 2).buffer);
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

export interface ValidatedDialogWav {
  durationMs: number;
  /** The decoded samples, so the caller levels them without decoding again. */
  pcm: Int16Array;
}

/**
 * Check that synthesized dialog audio is usable before it is cached or
 * scheduled: PCM16 mono at the expected rate, with samples, and not silent
 * throughout (no sample reaches the voiced threshold trimSilence uses).
 * Returns the duration and samples; throws with the reason otherwise.
 */
export function validateDialogWav(
  bytes: Uint8Array,
  expectedSampleRate: number,
): ValidatedDialogWav {
  const { pcm, sampleRate } = decodeWavPcm16(bytes);
  if (sampleRate !== expectedSampleRate) {
    throw new Error(`audio is ${sampleRate}Hz, expected ${expectedSampleRate}Hz`);
  }
  if (pcm.length === 0) {
    throw new Error("audio has no samples");
  }
  const voicedFloor = VOICED_THRESHOLD * 0x8000;
  if (!pcm.some((sample) => Math.abs(sample) > voicedFloor)) {
    throw new Error("audio is silent");
  }
  return { durationMs: Math.round((pcm.length / sampleRate) * 1000), pcm };
}

/**
 * Place each segment's samples at its scheduled offset in one silent WAV,
 * writing them straight into its data chunk. Overlaps are a scheduling bug
 * and fail loudly rather than mixing audio. Every segment must already be at
 * `sampleRate`: the narration builder validates each take at the provider's
 * rate before it levels and stitches them.
 */
export function stitchPcmSegments(
  segments: readonly { pcm: Int16Array; startMs: number }[],
  totalDurationMs: number,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const totalSamples = Math.ceil((totalDurationMs / 1000) * sampleRate);
  const wav = allocateWavPcm16(totalSamples, sampleRate);

  const placed = [...segments].sort((left, right) => left.startMs - right.startMs);
  let previousEndSample = 0;
  for (const segment of placed) {
    const startSample = Math.round((segment.startMs / 1000) * sampleRate);
    if (startSample < previousEndSample) {
      throw new Error(`Segment at ${segment.startMs}ms overlaps the previous one`);
    }
    if (startSample + segment.pcm.length > totalSamples) {
      throw new Error(`Segment at ${segment.startMs}ms runs past the stitched duration`);
    }
    wav.pcm.set(segment.pcm, startSample);
    previousEndSample = startSample + segment.pcm.length;
  }

  return wav.bytes;
}

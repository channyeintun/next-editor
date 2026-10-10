/**
 * AthanLab WAV normalization — pure and environment-agnostic, like ../wav.ts.
 * AthanLab does not document the sample rate, channel count or sample format
 * of the WAV it returns, while every dialog take must be 16-bit PCM mono at
 * the profile's rate (the Director validates, levels and stitches takes in
 * that one format). So whatever RIFF/WAVE comes back is decoded, mixed down to
 * mono, resampled, trimmed of lead-in and tail silence, and encoded again.
 *
 * No Web Audio: its decoders and resamplers differ between browsers, and a
 * take is cached by its request, so the same AthanLab audio must turn into the
 * same bytes everywhere. The resampler here is a rational polyphase filter
 * (a Kaiser-windowed sinc), which is exact for the common rates: 22050, 24000
 * and 44100 Hz all reach 48000 Hz with a few hundred filter phases at most.
 */

import { DATA, FMT_, readRiffChunks } from "../../../core/src/utils/wavPcm16";
import { encodeWavPcm16, floatTo16BitPcm, trimSilence } from "../wav";

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/**
 * Bytes 2–15 of every KSDATAFORMAT_SUBTYPE_* GUID; bytes 0–1 hold the
 * format tag (1 for PCM, 3 for IEEE float).
 */
const SUBFORMAT_GUID_TAIL = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/** Streamed WAVs leave their data size as one of these until the file is closed. */
const UNKNOWN_SIZE_PLACEHOLDERS = new Set([0, 0xffffffff]);

/** Rates this module reads and writes; outside them a header is not trusted. */
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 384_000;
/**
 * Longest audio accepted for one dialog. AthanLab speaks at most 5000
 * characters per request — a few minutes of speech — so a take far longer
 * than that is a broken header, and decoding it would only exhaust memory.
 */
const MAX_DIALOG_SECONDS = 15 * 60;

/** Zero crossings of the windowed sinc on each side of its centre. */
const ZERO_CROSSINGS = 16;
/** Passband edge as a share of the lower rate's Nyquist frequency. */
const CUTOFF_RATIO = 0.95;
/** Kaiser window shape: about 86 dB of stopband attenuation. */
const KAISER_BETA = 8.6;

type SampleReader = (view: DataView, offset: number) => number;

interface WavFormat {
  channels: number;
  sampleRate: number;
  bytesPerSample: number;
  blockAlign: number;
  read: SampleReader;
}

export interface DecodedMonoWav {
  /** Every channel averaged into one, in full-scale floats. */
  samples: Float32Array;
  sampleRate: number;
}

// 16-bit reads mirror floatTo16BitPcm's asymmetric scale (−0x8000 … 0x7fff),
// so PCM16 audio already at the target rate passes through unchanged.
const readInt16: SampleReader = (view, offset) => {
  const value = view.getInt16(offset, true);
  return value < 0 ? value / 0x8000 : value / 0x7fff;
};
const readUint8: SampleReader = (view, offset) => (view.getUint8(offset) - 128) / 128;
const readInt24: SampleReader = (view, offset) =>
  (view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16)) /
  0x800000;
const readInt32: SampleReader = (view, offset) => view.getInt32(offset, true) / 0x80000000;
// NaN or ±Infinity would smear across every output sample the filter touches.
const readFloat32: SampleReader = (view, offset) => {
  const value = view.getFloat32(offset, true);
  return Number.isFinite(value) ? value : 0;
};
const readFloat64: SampleReader = (view, offset) => {
  const value = view.getFloat64(offset, true);
  return Number.isFinite(value) ? value : 0;
};

const INTEGER_READERS: Partial<Record<number, SampleReader>> = {
  8: readUint8,
  16: readInt16,
  24: readInt24,
  32: readInt32,
};
const FLOAT_READERS: Partial<Record<number, SampleReader>> = {
  32: readFloat32,
  64: readFloat64,
};

function hex16(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function assertSampleRate(sampleRate: number, what: string): void {
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    throw new Error(
      `${what} sample rate ${sampleRate} Hz is outside ${MIN_SAMPLE_RATE}–${MAX_SAMPLE_RATE} Hz`,
    );
  }
}

function readFormat(view: DataView, body: number, size: number): WavFormat {
  if (size < 16) {
    throw new Error(`WAV fmt chunk is too short (${size} bytes)`);
  }
  if (body + size > view.byteLength) {
    throw new Error("WAV fmt chunk is truncated");
  }
  let formatTag = view.getUint16(body, true);
  const channels = view.getUint16(body + 2, true);
  const sampleRate = view.getUint32(body + 4, true);
  const blockAlign = view.getUint16(body + 12, true);
  // For WAVE_FORMAT_EXTENSIBLE this is the container size; fewer valid bits
  // sit left-justified in it, so reading the whole container scales them right.
  const bitsPerSample = view.getUint16(body + 14, true);

  if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
    if (size < 40) {
      throw new Error(`WAV WAVE_FORMAT_EXTENSIBLE fmt chunk is too short (${size} bytes)`);
    }
    formatTag = view.getUint16(body + 24, true);
    const knownGuid = SUBFORMAT_GUID_TAIL.every(
      (byte, index) => view.getUint8(body + 26 + index) === byte,
    );
    if (!knownGuid) {
      throw new Error("WAV WAVE_FORMAT_EXTENSIBLE sub-format is not PCM or IEEE float");
    }
  }

  let read: SampleReader | undefined;
  if (formatTag === WAVE_FORMAT_PCM) {
    read = INTEGER_READERS[bitsPerSample];
  } else if (formatTag === WAVE_FORMAT_IEEE_FLOAT) {
    read = FLOAT_READERS[bitsPerSample];
  } else {
    throw new Error(`Unsupported WAV sample format ${hex16(formatTag)}`);
  }
  if (!read) {
    const kind = formatTag === WAVE_FORMAT_PCM ? "integer PCM" : "IEEE float";
    throw new Error(`Unsupported WAV sample size: ${bitsPerSample}-bit ${kind}`);
  }
  if (channels === 0) {
    throw new Error("WAV declares no channels");
  }
  assertSampleRate(sampleRate, "WAV");
  const bytesPerSample = bitsPerSample / 8;
  if (blockAlign !== channels * bytesPerSample) {
    throw new Error(
      `WAV block align ${blockAlign} does not match ${channels} channel(s) of ${bitsPerSample}-bit samples`,
    );
  }
  return { channels, sampleRate, bytesPerSample, blockAlign, read };
}

/**
 * Whether a well-formed chunk starts at `offset` and fits the file — what
 * tells a genuinely empty data chunk from a streamed one whose zero size is a
 * placeholder for samples that run to the end of the file.
 */
function chunkStartsAt(view: DataView, offset: number): boolean {
  if (offset + 8 > view.byteLength) {
    return false;
  }
  for (let index = 0; index < 4; index++) {
    const byte = view.getUint8(offset + index);
    if (byte < 0x20 || byte > 0x7e) {
      return false;
    }
  }
  return offset + 8 + view.getUint32(offset + 4, true) <= view.byteLength;
}

/**
 * Decode a RIFF/WAVE file — integer PCM (8-bit unsigned, 16/24/32-bit signed)
 * or IEEE float (32/64-bit), plain or WAVE_FORMAT_EXTENSIBLE, any channel
 * count — into mono floats.
 */
export function decodeAthanLabWav(bytes: Uint8Array): DecodedMonoWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let format: WavFormat | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  for (const { id: chunkId, body, size: chunkSize } of readRiffChunks(view)) {
    if (chunkId === FMT_) {
      if (format) {
        throw new Error("WAV has more than one fmt chunk");
      }
      format = readFormat(view, body, chunkSize);
    } else if (chunkId === DATA) {
      if (dataOffset !== -1) {
        throw new Error("WAV has more than one data chunk");
      }
      dataOffset = body;
      dataSize = chunkSize;
      const remaining = bytes.byteLength - body;
      const placeholder =
        chunkSize > remaining ||
        (UNKNOWN_SIZE_PLACEHOLDERS.has(chunkSize) && !chunkStartsAt(view, body));
      if (placeholder) {
        // A streamed WAV whose writer never went back to fill in the size:
        // the samples run to the end of the file, whole frames only.
        if (!format) {
          throw new Error("WAV data chunk of unknown size comes before its fmt chunk");
        }
        dataSize = remaining - (remaining % format.blockAlign);
        break;
      }
    }
  }

  if (!format) {
    throw new Error("WAV is missing its fmt chunk");
  }
  if (dataOffset === -1) {
    throw new Error("WAV is missing its data chunk");
  }

  const { channels, sampleRate, bytesPerSample, blockAlign, read } = format;
  const frames = Math.floor(dataSize / blockAlign);
  if (frames > MAX_DIALOG_SECONDS * sampleRate) {
    throw new Error(
      `WAV runs ${Math.round(frames / sampleRate / 60)} minutes — longer than the ${MAX_DIALOG_SECONDS / 60}-minute limit for one dialog`,
    );
  }
  const samples = new Float32Array(frames);
  for (let frame = 0, frameOffset = dataOffset; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += read(view, frameOffset + channel * bytesPerSample);
    }
    samples[frame] = sum / channels;
    frameOffset += blockAlign;
  }
  return { samples, sampleRate };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Zeroth-order modified Bessel function of the first kind (power series). */
function besselI0(x: number): number {
  const halfX = x / 2;
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
    if (term < sum * 1e-15) {
      break;
    }
  }
  return sum;
}

interface PolyphaseFilter {
  /** Interpolation factor L: output samples per `down` input samples. */
  up: number;
  /** Decimation factor M. */
  down: number;
  /** Input samples each output sample reads. */
  taps: number;
  /** Phase p's taps are `coefficients[p * taps … (p + 1) * taps)`. */
  coefficients: Float64Array;
}

/**
 * The resampling filter for fromRate → toRate: a lowpass sinc cut at
 * CUTOFF_RATIO of the lower rate's Nyquist frequency, Kaiser-windowed across
 * ZERO_CROSSINGS zero crossings each side, sampled at the `up` fractional
 * offsets an output sample can fall on between two input samples. Each phase
 * sums to exactly 1, so no phase changes the level of the signal (or adds a
 * ripple at the phase rate).
 */
function designPolyphaseFilter(fromRate: number, toRate: number): PolyphaseFilter {
  const divisor = greatestCommonDivisor(fromRate, toRate);
  const up = toRate / divisor;
  const down = fromRate / divisor;
  // Cutoff in cycles per input sample; the sinc crosses zero every 1 / (2 · cutoff).
  const cutoff = (CUTOFF_RATIO * Math.min(fromRate, toRate)) / 2 / fromRate;
  const halfWidth = ZERO_CROSSINGS / (2 * cutoff);
  const reach = Math.ceil(halfWidth);
  const taps = 2 * reach;
  const coefficients = new Float64Array(up * taps);
  const windowNorm = besselI0(KAISER_BETA);

  for (let phase = 0; phase < up; phase++) {
    const fraction = phase / up;
    const row = phase * taps;
    let sum = 0;
    for (let tap = 0; tap < taps; tap++) {
      // Tap `tap` reads input sample n0 + 1 − reach + tap, for an output at n0 + fraction.
      const distance = fraction - (tap + 1 - reach);
      const position = distance / halfWidth;
      if (Math.abs(position) >= 1) {
        continue;
      }
      const window = besselI0(KAISER_BETA * Math.sqrt(1 - position * position)) / windowNorm;
      const argument = Math.PI * 2 * cutoff * distance;
      const sinc = argument === 0 ? 1 : Math.sin(argument) / argument;
      coefficients[row + tap] = window * sinc;
      sum += window * sinc;
    }
    for (let tap = 0; tap < taps; tap++) {
      coefficients[row + tap] /= sum;
    }
  }
  return { up, down, taps, coefficients };
}

/**
 * Resample with a rational polyphase Kaiser-windowed sinc filter. The output
 * holds `ceil(n · toRate / fromRate)` samples; equal rates return the input.
 */
export function resampleKaiserSinc(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  assertSampleRate(fromRate, "Source");
  assertSampleRate(toRate, "Target");
  if (fromRate === toRate) {
    return samples;
  }
  const { up, down, taps, coefficients } = designPolyphaseFilter(fromRate, toRate);
  const reach = taps / 2;
  const outputLength = Math.ceil((samples.length * up) / down);
  // Zeros stand in for the signal before and after the take, so every tap
  // reads inside the array.
  const padded = new Float32Array(samples.length + taps);
  padded.set(samples, reach);
  const output = new Float32Array(outputLength);

  let inputIndex = 0;
  let phase = 0;
  for (let index = 0; index < outputLength; index++) {
    const row = phase * taps;
    // padded[inputIndex + 1 + tap] is input sample inputIndex + 1 − reach + tap.
    const first = inputIndex + 1;
    let accumulator = 0;
    for (let tap = 0; tap < taps; tap++) {
      accumulator += coefficients[row + tap] * padded[first + tap];
    }
    output[index] = accumulator;
    phase += down;
    if (phase >= up) {
      const steps = Math.floor(phase / up);
      inputIndex += steps;
      phase -= steps * up;
    }
  }
  return output;
}

/**
 * Turn the WAV AthanLab returned into a dialog take: 16-bit PCM mono at
 * `targetSampleRate`, with the lead-in and tail silence trimmed the way every
 * provider's takes are (see trimSilence).
 */
export function normalizeAthanLabWav(bytes: Uint8Array, targetSampleRate: number): Uint8Array {
  assertSampleRate(targetSampleRate, "Target");
  const { samples, sampleRate } = decodeAthanLabWav(bytes);
  const resampled = resampleKaiserSinc(samples, sampleRate, targetSampleRate);
  const trimmed = trimSilence(resampled, targetSampleRate);
  return encodeWavPcm16(floatTo16BitPcm(trimmed), targetSampleRate);
}

import { encodeWavPcm16 } from "../tts/wav";

/**
 * FLAC takes from the offline narration notebook, back to the PCM16 WAV the
 * dialog cache keeps. FLAC is lossless, so the WAV holds the very samples the
 * notebook synthesized, at about half the size on the way here.
 */

export interface FlacStreamInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** The magic "fLaC", a metadata block header, and the stream info up to the sample format. */
const STREAM_INFO_BYTES = 4 + 4 + 14;

/** The stream info every FLAC file opens with. Throws on anything that is not FLAC. */
export function flacStreamInfoOf(bytes: Uint8Array): FlacStreamInfo {
  const isFlac =
    bytes.length >= STREAM_INFO_BYTES &&
    bytes[0] === 0x66 && // f
    bytes[1] === 0x4c && // L
    bytes[2] === 0x61 && // a
    bytes[3] === 0x43 && // C
    (bytes[4] & 0x7f) === 0; // the first metadata block is the stream info
  if (!isFlac) {
    throw new Error("not a FLAC file");
  }
  // Stream info: block sizes (4 bytes), frame sizes (6), then 20 bits of sample
  // rate, 3 of channels - 1, and 5 of bits per sample - 1.
  const at = 4 + 4 + 10;
  return {
    sampleRate: (bytes[at] << 12) | (bytes[at + 1] << 4) | (bytes[at + 2] >> 4),
    channels: ((bytes[at + 2] >> 1) & 0x07) + 1,
    bitsPerSample: (((bytes[at + 2] & 0x01) << 4) | (bytes[at + 3] >> 4)) + 1,
  };
}

type OfflineContext = Pick<OfflineAudioContext, "decodeAudioData">;
const contexts = new Map<number, OfflineContext>();

function contextAt(sampleRate: number): OfflineContext {
  let context = contexts.get(sampleRate);
  if (!context) {
    if (typeof OfflineAudioContext === "undefined") {
      throw new Error("this browser cannot decode FLAC audio");
    }
    context = new OfflineAudioContext(1, 1, sampleRate);
    contexts.set(sampleRate, context);
  }
  return context;
}

/**
 * What a decoder divided the positive 16-bit samples by. Chrome divides them
 * by 32767 and the negative ones by 32768; other decoders divide both by
 * 32768. Multiplied back by the right one, the samples land on whole numbers.
 */
function positiveScaleOf(samples: Float32Array): number {
  let off7fff = 0;
  let off8000 = 0;
  let seen = 0;
  for (let i = 0; i < samples.length && seen < 4096; i++) {
    const sample = samples[i];
    if (sample <= 0) continue;
    off7fff += Math.abs(sample * 0x7fff - Math.round(sample * 0x7fff));
    off8000 += Math.abs(sample * 0x8000 - Math.round(sample * 0x8000));
    seen += 1;
  }
  return off8000 < off7fff ? 0x8000 : 0x7fff;
}

/**
 * Decode a mono 16-bit FLAC take at the expected rate into a PCM16 WAV with
 * the same samples. Throws for another rate, layout or depth: the browser
 * would resample or downmix those without saying so.
 */
export async function decodeFlacToWavPcm16(
  flac: Uint8Array,
  expectedSampleRate: number,
): Promise<Uint8Array> {
  const info = flacStreamInfoOf(flac);
  if (info.sampleRate !== expectedSampleRate || info.channels !== 1 || info.bitsPerSample !== 16) {
    throw new Error(
      `expected mono 16-bit ${expectedSampleRate} Hz FLAC, got ${info.channels} channel(s), ${info.bitsPerSample}-bit, ${info.sampleRate} Hz`,
    );
  }
  // A context at the take's own rate decodes it sample for sample; the call
  // detaches the buffer it is given, so it gets a copy.
  const audio = await contextAt(expectedSampleRate).decodeAudioData(flac.slice().buffer);
  const samples = audio.getChannelData(0);
  const positiveScale = positiveScaleOf(samples);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const value = Math.round(sample < 0 ? sample * 0x8000 : sample * positiveScale);
    pcm[i] = Math.max(-0x8000, Math.min(0x7fff, value));
  }
  return encodeWavPcm16(pcm, expectedSampleRate);
}

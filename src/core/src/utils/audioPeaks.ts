import { decodeAudioBlob } from "./audioDecode";
import type { MediaSpan } from "./mediaSpans";

// ============================================================================
// A narration's loudness over time: drawn as the edit panel's waveform, and
// read to find the dead air worth cutting.
// ============================================================================

/** Decoding at 8 kHz keeps a long take small in memory; loudness needs no more. */
const PEAKS_DECODE_RATE = 8_000;

/** Loudness grid when nothing else sets one. */
const DEFAULT_BUCKET_MS = 50;

export interface AudioPeaks {
  /** The loudest sample in each bucket, 0–1. */
  peaks: Float32Array;
  /** How much audio each bucket covers. */
  bucketMs: number;
}

export async function computeAudioPeaks(
  blob: Blob,
  bucketMs = DEFAULT_BUCKET_MS,
): Promise<AudioPeaks> {
  const buffer = await decodeAudioBlob(blob, PEAKS_DECODE_RATE);
  const samplesPerBucket = Math.max(1, Math.round((PEAKS_DECODE_RATE * bucketMs) / 1000));
  const peaks = new Float32Array(Math.ceil(buffer.length / samplesPerBucket));
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index++) {
      const bucket = Math.floor(index / samplesPerBucket);
      const level = Math.abs(data[index]);
      if (level > peaks[bucket]) peaks[bucket] = level;
    }
  }
  return { peaks, bucketMs: (samplesPerBucket / PEAKS_DECODE_RATE) * 1000 };
}

export interface DeadAirOptions {
  durationMs: number;
  /** The narration's loudness, placed on the recording's clock; none for a silent take. */
  audio?: AudioPeaks & { offsetMs: number };
  /** When anything was recorded happening: an edit, a click, terminal output. */
  activityTimes: readonly number[];
  /** Quiet stretches shorter than this are pauses worth keeping. */
  minimumMs?: number;
  /** How much of each quiet stretch is left in, split either side of the cut. */
  keepMs?: number;
}

/** The quietest fifth of the take is its noise floor. */
const NOISE_FLOOR_PERCENTILE = 0.2;
/** Quiet means within this multiple of the noise floor. */
const QUIET_HEADROOM = 3;
/** Lowest quiet level: a gated room whose floor is digital silence. */
const QUIET_LEVEL_MIN = 0.015;
/** Highest quiet level: a noisy room, so speech still counts as speech. */
const QUIET_LEVEL_MAX = 0.08;

/**
 * The level below which the narration counts as quiet: well above its noise floor,
 * within bounds for a room with a noise gate or without.
 */
function quietLevel(peaks: Float32Array): number {
  if (peaks.length === 0) return 0;
  const sorted = Float32Array.from(peaks).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * NOISE_FLOOR_PERCENTILE)];
  return Math.min(QUIET_LEVEL_MAX, Math.max(QUIET_LEVEL_MIN, noiseFloor * QUIET_HEADROOM));
}

/** No real take is longer; bounds the busy grid against a hostile file's header. */
const MAX_DEAD_AIR_SCAN_MS = 24 * 60 * 60 * 1000;

/**
 * Stretches where nobody spoke and nothing happened, long enough to be dead air:
 * waiting on an install, looking something up. Each suggested cut leaves `keepMs` of
 * the stretch in, so the lesson still breathes there.
 */
export function suggestDeadAirCuts({
  durationMs,
  audio,
  activityTimes,
  minimumMs = 3_000,
  keepMs = 600,
}: DeadAirOptions): MediaSpan[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const scanMs = Math.min(durationMs, MAX_DEAD_AIR_SCAN_MS);
  const stepMs = audio?.bucketMs ?? DEFAULT_BUCKET_MS;
  const steps = Math.ceil(scanMs / stepMs);
  if (steps <= 0) return [];
  const busy = new Uint8Array(steps);

  if (audio) {
    const level = quietLevel(audio.peaks);
    audio.peaks.forEach((peak, bucket) => {
      if (peak <= level) return;
      const step = Math.floor((audio.offsetMs + bucket * audio.bucketMs) / stepMs);
      if (step >= 0 && step < steps) busy[step] = 1;
    });
  }
  for (const time of activityTimes) {
    const step = Math.floor(time / stepMs);
    if (step >= 0 && step < steps) busy[step] = 1;
  }

  const cuts: MediaSpan[] = [];
  let runStart = -1;
  const closeRun = (end: number) => {
    const start = runStart * stepMs;
    const stop = Math.min(scanMs, end * stepMs);
    if (stop - start >= minimumMs) {
      cuts.push({ start: start + keepMs / 2, end: stop - keepMs / 2 });
    }
    runStart = -1;
  };
  for (let step = 0; step < steps; step++) {
    if (!busy[step]) {
      if (runStart < 0) runStart = step;
    } else if (runStart >= 0) {
      closeRun(step);
    }
  }
  if (runStart >= 0) closeRun(steps);
  return cuts;
}

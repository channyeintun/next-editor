/**
 * Loudness leveling for narration dialogs — pure and environment-agnostic,
 * like wav.ts. Every dialog is synthesized on its own, and the speech models
 * do not keep one output level from request to request, so a stitched
 * narration can step up and down in volume at dialog boundaries. Before the
 * stitch, each dialog gets one static gain that brings it to a level shared
 * by the whole narration. Nothing is compressed or limited: the gain is a
 * single number per dialog, so the sound and every duration stay exactly as
 * synthesized.
 *
 * Loudness is ITU-R BS.1770-4 integrated loudness (LUFS) of a mono signal:
 * K-weighting, 400 ms blocks with 75 % overlap, then an absolute gate at
 * −70 LUFS and a relative gate 10 LU below the level of what is left. The
 * gates keep the pauses between words and sentences from pulling the
 * measurement down.
 */

/** Spoken-word level for a narration track; the shared level never goes above it. */
export const NARRATION_LOUDNESS_TARGET_LUFS = -18;
/**
 * Lowest the shared level drops for a peaky or quiet dialog. A dialog that
 * cannot reach even this level is the one that ends quieter.
 */
export const NARRATION_LOUDNESS_FLOOR_LUFS = -24;
/** Largest boost or cut, so a near-silent or broken take is not blown up. */
export const NARRATION_MAX_GAIN_DB = 12;
/** Highest sample peak after the gain: no clipping, and headroom for the Opus encoder. */
export const NARRATION_PEAK_CEILING_DBFS = -1;

/**
 * Everything that decides how the stitched narration is leveled. The Director
 * folds it into the narration key, so changing any of it (or the algorithm,
 * via `version`) re-keys the plan instead of silently changing its audio.
 */
export const NARRATION_LEVELING = {
  version: 1,
  targetLufs: NARRATION_LOUDNESS_TARGET_LUFS,
  floorLufs: NARRATION_LOUDNESS_FLOOR_LUFS,
  maxGainDb: NARRATION_MAX_GAIN_DB,
  peakCeilingDbfs: NARRATION_PEAK_CEILING_DBFS,
} as const;

/** BS.1770 gating block length and the hop between block starts (75 % overlap). */
const BLOCK_SECONDS = 0.4;
const BLOCKS_PER_WINDOW = 4;
/** Blocks at or below this level are silence and never count. */
const ABSOLUTE_GATE_LUFS = -70;
/** Blocks this far below the level of the absolute-gated blocks do not count. */
const RELATIVE_GATE_LU = -10;
/** Cancels the K-weighting gain at 997 Hz, so a full-scale 997 Hz sine reads −3.01 LUFS. */
const LOUDNESS_OFFSET_DB = -0.691;

/** Int16 full scale: PCM samples are read as sample / 32768. */
const FULL_SCALE = 0x8000;
const INT16_MIN = -0x8000;
const INT16_MAX = 0x7fff;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages for any sample rate, derived the way libebur128
 * does from the analog prototypes behind BS.1770's 48 kHz table: a high shelf
 * (about +4 dB above 1.7 kHz, the effect of the head) and the RLB high-pass
 * (about 38 Hz). Speech providers here use 24 kHz and 48 kHz.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  const shelfHz = 1681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  let k = Math.tan((Math.PI * shelfHz) / sampleRate);
  const vh = 10 ** (shelfGainDb / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / shelfQ + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / shelfQ + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / shelfQ + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / shelfQ + k * k) / a0,
  };

  const highPassHz = 38.13547087602444;
  const highPassQ = 0.5003270373238773;
  k = Math.tan((Math.PI * highPassHz) / sampleRate);
  a0 = 1 + k / highPassQ + k * k;
  const highPass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / highPassQ + k * k) / a0,
  };
  return [shelf, highPass];
}

/** Squared K-weighted samples, filtered from a zero state (transposed direct form II). */
function kWeightedSquares(samples: ArrayLike<number>, sampleRate: number): Float64Array {
  const [shelf, highPass] = kWeightingFilters(sampleRate);
  const squares = new Float64Array(samples.length);
  let s1 = 0;
  let s2 = 0;
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const shelved = shelf.b0 * x + s1;
    s1 = shelf.b1 * x - shelf.a1 * shelved + s2;
    s2 = shelf.b2 * x - shelf.a2 * shelved;
    const y = highPass.b0 * shelved + h1;
    h1 = highPass.b1 * shelved - highPass.a1 * y + h2;
    h2 = highPass.b2 * shelved - highPass.a2 * y;
    squares[i] = y * y;
  }
  return squares;
}

function loudnessOf(meanSquare: number): number {
  return LOUDNESS_OFFSET_DB + 10 * Math.log10(meanSquare);
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/**
 * Mean square of each gating block. A clip shorter than one block is measured
 * as one block over all of it, so a short dialog still gets a level.
 */
function blockMeanSquares(squares: Float64Array, sampleRate: number): number[] {
  const hop = Math.max(1, Math.round((BLOCK_SECONDS / BLOCKS_PER_WINDOW) * sampleRate));
  const block = hop * BLOCKS_PER_WINDOW;
  if (squares.length < block) {
    let sum = 0;
    for (const square of squares) {
      sum += square;
    }
    return squares.length === 0 ? [] : [sum / squares.length];
  }

  // Sum each hop once; a block is four neighbouring hops.
  const hopCount = Math.floor(squares.length / hop);
  const hopSums = new Float64Array(hopCount);
  for (let h = 0; h < hopCount; h++) {
    let sum = 0;
    for (let i = h * hop; i < (h + 1) * hop; i++) {
      sum += squares[i];
    }
    hopSums[h] = sum;
  }
  const blocks: number[] = [];
  for (let first = 0; first + BLOCKS_PER_WINDOW <= hopCount; first++) {
    let sum = 0;
    for (let h = first; h < first + BLOCKS_PER_WINDOW; h++) {
      sum += hopSums[h];
    }
    blocks.push(sum / block);
  }
  return blocks;
}

/**
 * ITU-R BS.1770-4 integrated loudness of a mono signal (samples in −1…1), in
 * LUFS. Returns null for silence: no block passes the absolute gate.
 */
export function measureIntegratedLoudness(
  samples: ArrayLike<number>,
  sampleRate: number,
): number | null {
  const blocks = blockMeanSquares(kWeightedSquares(samples, sampleRate), sampleRate);
  const audible = blocks.filter((meanSquare) => loudnessOf(meanSquare) > ABSOLUTE_GATE_LUFS);
  if (audible.length === 0) {
    return null;
  }
  const relativeGate = loudnessOf(meanOf(audible)) + RELATIVE_GATE_LU;
  const gated = audible.filter((meanSquare) => loudnessOf(meanSquare) > relativeGate);
  return loudnessOf(meanOf(gated));
}

/** One take's loudness and sample peak, measured once. */
interface TakeLevel {
  /** Integrated loudness in LUFS; null for silence. */
  loudnessLufs: number | null;
  /** Largest absolute sample, in Int16 units. */
  peak: number;
}

function measureTake(pcm: Int16Array, sampleRate: number): TakeLevel {
  const samples = new Float32Array(pcm.length);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    samples[i] = pcm[i] / FULL_SCALE;
    peak = Math.max(peak, Math.abs(pcm[i]));
  }
  return { loudnessLufs: peak === 0 ? null : measureIntegratedLoudness(samples, sampleRate), peak };
}

function decibelsOf(ratio: number): number {
  return 20 * Math.log10(ratio);
}

/**
 * The linear gain that moves a take to the target: limited to ±maxGainDb, then
 * lowered if needed so the sample peak stays at or below the ceiling. Silence
 * keeps a gain of 1.
 */
function gainFor(
  take: TakeLevel,
  targetLufs: number,
  maxGainDb: number,
  peakCeilingDbfs: number,
): number {
  if (take.loudnessLufs === null) {
    return 1;
  }
  const gainDb = Math.min(maxGainDb, Math.max(-maxGainDb, targetLufs - take.loudnessLufs));
  const ceiling = Math.floor(FULL_SCALE * 10 ** (peakCeilingDbfs / 20));
  return Math.min(10 ** (gainDb / 20), ceiling / take.peak);
}

function applyGain(pcm: Int16Array, gain: number): Int16Array {
  if (gain === 1) {
    return pcm;
  }
  const scaled = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    scaled[i] = Math.min(INT16_MAX, Math.max(INT16_MIN, Math.round(pcm[i] * gain)));
  }
  return scaled;
}

export interface NarrationLevelingOptions {
  targetLufs?: number;
  floorLufs?: number;
  maxGainDb?: number;
  peakCeilingDbfs?: number;
}

export interface LeveledDialog {
  pcm: Int16Array;
  /** Loudness as synthesized (LUFS); null for silence. */
  measuredLufs: number | null;
  /** Loudness after the gain (LUFS); null for silence. */
  leveledLufs: number | null;
}

export interface LeveledNarration {
  /** The loudness the dialogs were brought to (LUFS). */
  levelLufs: number;
  dialogs: LeveledDialog[];
}

/**
 * Level every dialog of one narration to a shared loudness.
 *
 * The shared level is the target, unless some dialog cannot reach it: its
 * peaks would pass the ceiling there, or it sits more than the gain limit
 * under it. Then the whole narration comes down to the loudest level that
 * dialog can reach: leaving only that dialog short would make it quieter than
 * its neighbours, which is the step this exists to remove. The peak case is
 * the common one, not an exception: the peaks of 453 measured Pocket-TTS
 * takes sat 15–20 dB above their loudness, so most would pass −1 dBFS at
 * −18 LUFS. The gain case covers a narration that came out quiet as a whole,
 * such as one cloned from a quiet recording. A dialog that cannot reach even
 * the floor does not pull the level down, and ends off it instead
 * (`leveledLufs` shows by how much), so one broken take cannot make the whole
 * lesson quiet.
 */
export function levelNarrationDialogs(
  takes: readonly Int16Array[],
  sampleRate: number,
  {
    targetLufs = NARRATION_LOUDNESS_TARGET_LUFS,
    floorLufs = NARRATION_LOUDNESS_FLOOR_LUFS,
    maxGainDb = NARRATION_MAX_GAIN_DB,
    peakCeilingDbfs = NARRATION_PEAK_CEILING_DBFS,
  }: NarrationLevelingOptions = {},
): LeveledNarration {
  const measured = takes.map((pcm) => measureTake(pcm, sampleRate));
  let levelLufs = targetLufs;
  for (const take of measured) {
    if (take.loudnessLufs === null) {
      continue;
    }
    // The loudest this take gets: its highest sample on the ceiling, or the
    // largest boost, whichever comes first.
    const peakBoundLufs = take.loudnessLufs + peakCeilingDbfs - decibelsOf(take.peak / FULL_SCALE);
    const reachLufs = Math.min(peakBoundLufs, take.loudnessLufs + maxGainDb);
    if (reachLufs >= floorLufs) {
      levelLufs = Math.min(levelLufs, reachLufs);
    }
  }

  return {
    levelLufs,
    dialogs: takes.map((pcm, index) => {
      const take = measured[index];
      const gain = gainFor(take, levelLufs, maxGainDb, peakCeilingDbfs);
      return {
        pcm: applyGain(pcm, gain),
        measuredLufs: take.loudnessLufs,
        leveledLufs: take.loudnessLufs === null ? null : take.loudnessLufs + decibelsOf(gain),
      };
    }),
  };
}

// ============================================================================
// Microphone level: how loud the input is, for the microphone check and the
// meter beside a running take. Levels are dBFS (0 is full scale).
// ============================================================================

/** The meter's floor: anything quieter shows as an empty bar. */
export const METER_FLOOR_DB = -60;
/** Below this the input is as good as silent: a muted or disconnected microphone. */
export const SILENCE_DB = -80;
/** Loudest speech below this is hard to hear back. */
export const QUIET_SPEECH_DB = -45;
/** Loudest speech at or above this is a healthy level. */
export const GOOD_SPEECH_DB = -30;
/** Samples this close to full scale are clipping. */
export const CLIPPING_DB = -1;

export interface LevelReading {
  /** Root-mean-square level, dBFS. */
  rmsDb: number;
  /** Largest sample, dBFS. */
  peakDb: number;
}

const toDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

/** The level of one buffer of samples in -1..1. */
export function measureLevel(samples: Float32Array): LevelReading {
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return {
    rmsDb: toDb(Math.sqrt(sumSquares / Math.max(1, samples.length))),
    peakDb: toDb(peak),
  };
}

/** Where a level sits on a meter: 0 at or below the floor, 1 at full scale. */
export function meterFraction(db: number): number {
  if (!(db > METER_FLOOR_DB)) return 0;
  return Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB);
}

/**
 * What the last few seconds say about the input: still `listening`, `silent` (nothing at
 * all), `waiting` (room sound but no speech), speech that is `quiet` or `good`, or `loud`
 * enough to clip.
 */
export type MicrophoneVerdict = "listening" | "silent" | "waiting" | "quiet" | "good" | "loud";

/** Rolling readings over a window, judged as a whole: speech comes and goes. */
export class LevelMonitor {
  private readonly windowMs: number;
  private readonly readings: Array<LevelReading & { at: number }> = [];
  private startedAt: number | null = null;
  /** Whether anything like speech has come in since the monitor started. */
  heardSpeech = false;

  constructor(windowMs = 3_000) {
    this.windowMs = windowMs;
  }

  add(reading: LevelReading, at: number): void {
    this.startedAt ??= at;
    this.readings.push({ ...reading, at });
    while (this.readings[0].at < at - this.windowMs) this.readings.shift();
    if (reading.rmsDb >= QUIET_SPEECH_DB) this.heardSpeech = true;
  }

  /** How long the monitor has been listening, in ms. */
  listenedMs(at: number): number {
    return this.startedAt === null ? 0 : at - this.startedAt;
  }

  verdict(at: number): MicrophoneVerdict {
    if (this.readings.length === 0) return "listening";
    let loudestRms = -Infinity;
    let loudestPeak = -Infinity;
    for (const reading of this.readings) {
      loudestRms = Math.max(loudestRms, reading.rmsDb);
      loudestPeak = Math.max(loudestPeak, reading.peakDb);
    }
    if (loudestPeak >= CLIPPING_DB) return "loud";
    if (loudestRms >= GOOD_SPEECH_DB) return "good";
    if (loudestRms >= QUIET_SPEECH_DB) return "quiet";
    if (loudestRms > SILENCE_DB) return "waiting";
    // A moment of silence is normal; a whole window of it is not.
    return this.listenedMs(at) >= this.windowMs ? "silent" : "listening";
  }
}

/**
 * Meters `stream` once per animation frame until the returned function is called. The
 * analyser only listens: nothing is played, and the stream's recorder is unaffected.
 */
export function startLevelMeter(
  stream: MediaStream,
  onReading: (reading: LevelReading, at: number) => void,
): () => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  // Started after a click (the check's, or the record button's), so the browser allows it.
  void context.resume().catch(() => {});

  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  const tick = (at: number) => {
    analyser.getFloatTimeDomainData(samples);
    onReading(measureLevel(samples), at);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    void context.close().catch(() => {});
  };
}

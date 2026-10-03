import { describe, expect, it } from "vite-plus/test";
import {
  kWeightingFilters,
  levelNarrationDialogs,
  measureIntegratedLoudness,
  NARRATION_LOUDNESS_FLOOR_LUFS,
  NARRATION_LOUDNESS_TARGET_LUFS,
  normalizeDialogLoudness,
} from "./loudness";

const PEAK_CEILING = 10 ** (-1 / 20);

function sine(amplitude: number, seconds: number, sampleRate: number, hz = 997): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return samples;
}

function toPcm(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, (sample) => Math.round(sample * 0x7fff));
}

/** A 220 Hz tone with a one-sample click every 100 ms: high peaks over a steady level. */
function peakyPcm(toneAmplitude: number, clickAmplitude: number, sampleRate: number): Int16Array {
  const pcm = toPcm(sine(toneAmplitude, 3, sampleRate, 220));
  for (let i = 0; i < pcm.length; i += sampleRate / 10) {
    pcm[i] = Math.round(clickAmplitude * 0x7fff);
  }
  return pcm;
}

function loudnessOf(pcm: Int16Array, sampleRate: number): number | null {
  return measureIntegratedLoudness(
    Float32Array.from(pcm, (sample) => sample / 0x8000),
    sampleRate,
  );
}

function peakOf(pcm: Int16Array): number {
  return pcm.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0) / 0x8000;
}

/** |actual − expected| in LU; fails on a null (silent) measurement. */
function offBy(actual: number | null, expected: number): number {
  if (actual === null) {
    throw new Error("expected a loudness, measured silence");
  }
  return Math.abs(actual - expected);
}

describe("measureIntegratedLoudness", () => {
  it("matches BS.1770's 48 kHz K-weighting table", () => {
    const [shelf, highPass] = kWeightingFilters(48_000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 12);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 12);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 12);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 12);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 12);
    expect(highPass).toMatchObject({ b0: 1, b1: -2, b2: 1 });
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 12);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 12);
  });

  it.each([48_000, 24_000])("reads a 997 Hz sine at its BS.1770 level at %i Hz", (sampleRate) => {
    expect(
      offBy(measureIntegratedLoudness(sine(1, 5, sampleRate), sampleRate), -3.01),
    ).toBeLessThanOrEqual(0.1);
    expect(
      offBy(measureIntegratedLoudness(sine(0.1, 5, sampleRate), sampleRate), -23.01),
    ).toBeLessThanOrEqual(0.1);
  });

  it("gates out silence, so half tone and half silence reads as the tone", () => {
    const sampleRate = 48_000;
    const clip = new Float32Array(20 * sampleRate);
    clip.set(sine(0.1, 10, sampleRate));
    expect(offBy(measureIntegratedLoudness(clip, sampleRate), -23.01)).toBeLessThanOrEqual(0.1);
  });

  it("measures a clip shorter than one block as one block", () => {
    expect(
      offBy(measureIntegratedLoudness(sine(0.1, 0.2, 24_000), 24_000), -23.01),
    ).toBeLessThanOrEqual(0.1);
  });

  it("returns null for silence", () => {
    expect(measureIntegratedLoudness(new Float32Array(48_000), 48_000)).toBeNull();
    expect(measureIntegratedLoudness(sine(1e-5, 1, 48_000), 48_000)).toBeNull();
    expect(measureIntegratedLoudness(new Float32Array(0), 48_000)).toBeNull();
  });
});

describe("normalizeDialogLoudness", () => {
  const sampleRate = 24_000;

  it("brings two clips 9 dB apart to the same target", () => {
    const quiet = toPcm(sine(0.05, 3, sampleRate));
    const loud = toPcm(sine(0.05 * 10 ** (9 / 20), 3, sampleRate));
    expect(loudnessOf(loud, sampleRate)! - loudnessOf(quiet, sampleRate)!).toBeCloseTo(9, 1);

    for (const clip of [quiet, loud]) {
      const leveled = normalizeDialogLoudness(clip, sampleRate);
      expect(leveled).toHaveLength(clip.length);
      expect(
        offBy(loudnessOf(leveled, sampleRate), NARRATION_LOUDNESS_TARGET_LUFS),
      ).toBeLessThanOrEqual(0.2);
    }
  });

  it("keeps a peaky clip under the ceiling instead of clipping it", () => {
    const peaky = peakyPcm(0.02, 0.9, sampleRate);
    const leveled = normalizeDialogLoudness(peaky, sampleRate);
    expect(peakOf(leveled)).toBeLessThanOrEqual(PEAK_CEILING);
    expect(loudnessOf(leveled, sampleRate)!).toBeLessThan(NARRATION_LOUDNESS_TARGET_LUFS - 1);
  });

  it("limits the gain to 12 dB either way", () => {
    // About −49 and −3 LUFS: 31 dB under and 15 dB over the target.
    const veryQuiet = toPcm(sine(0.005, 3, sampleRate));
    const veryLoud = toPcm(sine(1, 3, sampleRate));
    for (const [clip, gainDb] of [
      [veryQuiet, 12],
      [veryLoud, -12],
    ] as const) {
      const leveled = loudnessOf(normalizeDialogLoudness(clip, sampleRate), sampleRate);
      expect(offBy(leveled, loudnessOf(clip, sampleRate)! + gainDb)).toBeLessThanOrEqual(0.05);
    }
  });

  it("returns silence unchanged", () => {
    const silence = new Int16Array(sampleRate);
    expect(normalizeDialogLoudness(silence, sampleRate)).toEqual(silence);
  });

  it("gives the same samples for the same input", () => {
    const clip = peakyPcm(0.05, 0.4, sampleRate);
    expect(normalizeDialogLoudness(clip, sampleRate)).toEqual(
      normalizeDialogLoudness(clip.slice(), sampleRate),
    );
  });
});

describe("levelNarrationDialogs", () => {
  const sampleRate = 48_000;

  function expectAllAt(dialogs: { pcm: Int16Array }[], levelLufs: number) {
    for (const { pcm } of dialogs) {
      expect(offBy(loudnessOf(pcm, sampleRate), levelLufs)).toBeLessThanOrEqual(0.2);
      expect(peakOf(pcm)).toBeLessThanOrEqual(PEAK_CEILING);
    }
  }

  it("brings dialogs with headroom to the target", () => {
    const takes = [0.05, 0.1, 0.2].map((amplitude) => toPcm(sine(amplitude, 2, sampleRate)));
    const { levelLufs, dialogs } = levelNarrationDialogs(takes, sampleRate);
    expect(levelLufs).toBe(NARRATION_LOUDNESS_TARGET_LUFS);
    expectAllAt(dialogs, NARRATION_LOUDNESS_TARGET_LUFS);
    expect(dialogs.map(({ pcm }) => pcm.length)).toEqual(takes.map((take) => take.length));
  });

  it("lowers the whole narration for a peaky dialog rather than leaving it quieter", () => {
    const peaky = peakyPcm(0.1, 0.9, sampleRate);
    const takes = [toPcm(sine(0.05, 2, sampleRate)), peaky, toPcm(sine(0.2, 2, sampleRate))];
    const { levelLufs, dialogs } = levelNarrationDialogs(takes, sampleRate);

    expect(levelLufs).toBeLessThan(NARRATION_LOUDNESS_TARGET_LUFS - 1);
    expect(levelLufs).toBeGreaterThanOrEqual(NARRATION_LOUDNESS_FLOOR_LUFS);
    expectAllAt(dialogs, levelLufs);
    expect(peakOf(dialogs[1].pcm)).toBeCloseTo(PEAK_CEILING, 3);
    for (const dialog of dialogs) {
      expect(dialog.leveledLufs! - levelLufs).toBeCloseTo(0, 2);
    }
  });

  it("lowers the whole narration for a quiet dialog the gain limit holds back", () => {
    // About −31 and −34 LUFS, as from a voice cloned off a quiet recording:
    // 12 dB brings them only to about −19 and −22, so all meet at −22.
    const takes = [toPcm(sine(0.04, 2, sampleRate)), toPcm(sine(0.028, 2, sampleRate))];
    const { levelLufs, dialogs } = levelNarrationDialogs(takes, sampleRate);

    expect(levelLufs).toBeLessThan(NARRATION_LOUDNESS_TARGET_LUFS - 3);
    expect(levelLufs).toBeGreaterThanOrEqual(NARRATION_LOUDNESS_FLOOR_LUFS);
    expectAllAt(dialogs, levelLufs);
    expect(dialogs[1].leveledLufs! - dialogs[1].measuredLufs!).toBeCloseTo(12, 6);
  });

  it("does not let one dialog pull the level under the floor", () => {
    // About −34 LUFS with clicks near full scale: matching it would need the
    // whole narration at about −34 LUFS, far under the floor.
    const tooPeaky = peakyPcm(0.01, 0.9, sampleRate);
    // About −43 LUFS: the 12 dB gain limit brings it only to about −31, under the floor.
    const tooQuiet = toPcm(sine(0.01, 2, sampleRate));
    const normal = toPcm(sine(0.1, 2, sampleRate));
    const { levelLufs, dialogs } = levelNarrationDialogs([normal, tooPeaky, tooQuiet], sampleRate);

    expect(levelLufs).toBe(NARRATION_LOUDNESS_TARGET_LUFS);
    expectAllAt([dialogs[0]], levelLufs);
    expect(peakOf(dialogs[1].pcm)).toBeLessThanOrEqual(PEAK_CEILING);
    expect(dialogs[1].leveledLufs!).toBeLessThan(levelLufs - 1);
    expect(dialogs[2].leveledLufs! - dialogs[2].measuredLufs!).toBeCloseTo(12, 6);
  });

  it("leaves silent dialogs alone and is repeatable", () => {
    const takes = [toPcm(sine(0.1, 2, sampleRate)), new Int16Array(sampleRate)];
    const first = levelNarrationDialogs(takes, sampleRate);
    const second = levelNarrationDialogs(
      takes.map((take) => take.slice()),
      sampleRate,
    );
    expect(first.dialogs[1]).toEqual({ pcm: takes[1], measuredLufs: null, leveledLufs: null });
    expect(second).toEqual(first);
  });
});

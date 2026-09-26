import { describe, expect, it } from "vite-plus/test";
import {
  WHISPER_N_FFT,
  WHISPER_N_FRAMES,
  WHISPER_N_MELS,
  WHISPER_SAMPLE_RATE,
  createMelFilterbank,
  realDftForTest,
  whisperLogMel,
} from "./melSpectrogram";

function naiveDft(input: Float64Array) {
  const n = input.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      re[k] += input[t] * Math.cos((2 * Math.PI * k * t) / n);
      im[k] -= input[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
  }
  return { re, im };
}

/** A deterministic, non-periodic signal. */
function signal(length: number): Float64Array {
  return Float64Array.from(
    { length },
    (_, index) => Math.sin(index * 1.7) + Math.cos(index * index * 0.013),
  );
}

describe("the mixed-radix FFT", () => {
  // 400 is Whisper's frame (2^4 · 5^2); the others cover a prime, one radix, and mixed ones.
  for (const size of [WHISPER_N_FFT, 7, 8, 12, 25, 60]) {
    it(`matches a direct DFT of ${size} samples`, () => {
      const input = signal(size);
      const fast = realDftForTest(input);
      const direct = naiveDft(input);
      for (let k = 0; k < size; k++) {
        expect(fast.re[k]).toBeCloseTo(direct.re[k], 8);
        expect(fast.im[k]).toBeCloseTo(direct.im[k], 8);
      }
    });
  }
});

describe("createMelFilterbank", () => {
  const bins = WHISPER_N_FFT / 2 + 1;
  const binHz = WHISPER_SAMPLE_RATE / WHISPER_N_FFT;
  const filters = createMelFilterbank();
  const row = (mel: number) => filters.subarray(mel * bins, (mel + 1) * bins);

  it("has one non-negative triangle per mel band", () => {
    expect(filters).toHaveLength(WHISPER_N_MELS * bins);
    for (let mel = 0; mel < WHISPER_N_MELS; mel++) {
      expect(Math.min(...row(mel))).toBeGreaterThanOrEqual(0);
      expect(Math.max(...row(mel))).toBeGreaterThan(0);
    }
  });

  it("orders bands from low to high frequency", () => {
    const centroid = (mel: number) => {
      let weighted = 0;
      let total = 0;
      row(mel).forEach((weight, bin) => {
        weighted += weight * bin;
        total += weight;
      });
      return weighted / total;
    };
    for (let mel = 1; mel < WHISPER_N_MELS; mel++) {
      expect(centroid(mel)).toBeGreaterThan(centroid(mel - 1));
    }
  });

  it("is Slaney-normalized: each band wide enough to sample integrates to about 1 over Hz", () => {
    // Bands above ~1 kHz span many bins, so the sampled area is close to the continuous one.
    for (let mel = 40; mel < WHISPER_N_MELS; mel++) {
      const area = row(mel).reduce((sum, weight) => sum + weight, 0) * binHz;
      expect(area).toBeGreaterThan(0.9);
      expect(area).toBeLessThan(1.1);
    }
  });
});

describe("whisperLogMel", () => {
  it("returns 80 bands of 3000 frames for any window, padding short audio", () => {
    expect(whisperLogMel(new Float32Array(1600))).toHaveLength(WHISPER_N_MELS * WHISPER_N_FRAMES);
  });

  it("maps silence to one flat value", () => {
    const features = whisperLogMel(new Float32Array(WHISPER_SAMPLE_RATE));
    // log10(1e-10) everywhere: the peak, so nothing is clamped, rescaled as (x + 4) / 4.
    expect(new Set(features)).toEqual(new Set([-1.5]));
  });

  it("puts a tone's energy in the band around its frequency, and clamps 8 below the peak", () => {
    const hz = 1000;
    const tone = Float32Array.from(
      { length: 2 * WHISPER_SAMPLE_RATE },
      (_, index) => 0.5 * Math.sin((2 * Math.PI * hz * index) / WHISPER_SAMPLE_RATE),
    );
    const features = whisperLogMel(tone);
    const frame = 50; // well inside the tone
    let loudest = 0;
    for (let band = 1; band < WHISPER_N_MELS; band++) {
      if (
        features[band * WHISPER_N_FRAMES + frame] > features[loudest * WHISPER_N_FRAMES + frame]
      ) {
        loudest = band;
      }
    }
    const filters = createMelFilterbank();
    const bins = WHISPER_N_FFT / 2 + 1;
    const toneBin = hz / (WHISPER_SAMPLE_RATE / WHISPER_N_FFT);
    expect(filters[loudest * bins + toneBin]).toBeGreaterThan(0);

    const peak = features.reduce((max, value) => Math.max(max, value), -Infinity);
    const floor = features.reduce((min, value) => Math.min(min, value), Infinity);
    expect(peak - floor).toBeCloseTo(2, 5); // 8 in log10 units, divided by 4
    // Past the tone the window is zero padding: every value sits at the floor.
    const pastTone = (2 * WHISPER_SAMPLE_RATE) / 160 + 10;
    expect(features[loudest * WHISPER_N_FRAMES + pastTone]).toBeCloseTo(floor, 5);
  });
});

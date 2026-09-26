// ============================================================================
// Whisper's input features: an 80-bin log-mel spectrogram of a 30 s window of
// 16 kHz mono audio, computed as OpenAI's reference and transformers'
// WhisperFeatureExtractor do (librosa's Slaney mel filters, a centered
// reflect-padded STFT with a periodic Hann window, log10 clamped to 8 below the
// peak and rescaled).
// ============================================================================

export const WHISPER_SAMPLE_RATE = 16_000;
export const WHISPER_N_FFT = 400;
export const WHISPER_HOP_LENGTH = 160;
export const WHISPER_N_MELS = 80;
/** One window: 30 s of audio. */
export const WHISPER_CHUNK_SAMPLES = 30 * WHISPER_SAMPLE_RATE;
/** Frames per window: one per hop, the STFT's trailing frame dropped. */
export const WHISPER_N_FRAMES = WHISPER_CHUNK_SAMPLES / WHISPER_HOP_LENGTH;

const N_BINS = WHISPER_N_FFT / 2 + 1;

// --- Mixed-radix FFT ------------------------------------------------------------
// 400 is not a power of two (2^4 · 5^2), and padding the frame to 512 would change
// every bin's frequency, so the transform is a recursive mixed-radix Cooley–Tukey.

function smallestFactor(n: number): number {
  for (let factor = 2; factor * factor <= n; factor++) {
    if (n % factor === 0) return factor;
  }
  return n;
}

class MixedRadixFft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly scratchRe: Float64Array;
  private readonly scratchIm: Float64Array;

  constructor(size: number) {
    this.size = size;
    this.cos = new Float64Array(size);
    this.sin = new Float64Array(size);
    for (let index = 0; index < size; index++) {
      this.cos[index] = Math.cos((2 * Math.PI * index) / size);
      this.sin[index] = -Math.sin((2 * Math.PI * index) / size);
    }
    this.scratchRe = new Float64Array(size);
    this.scratchIm = new Float64Array(size);
  }

  /** The DFT of a real signal of `size` samples, into `outRe`/`outIm` (full length). */
  transformReal(input: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    this.recurse(input, 0, 1, this.size, outRe, outIm, 0);
  }

  private recurse(
    input: Float64Array,
    offset: number,
    stride: number,
    n: number,
    outRe: Float64Array,
    outIm: Float64Array,
    outOffset: number,
  ): void {
    if (n === 1) {
      outRe[outOffset] = input[offset];
      outIm[outOffset] = 0;
      return;
    }
    const radix = smallestFactor(n);
    const m = n / radix;
    // Transform each of the `radix` interleaved subsequences into consecutive runs.
    for (let r = 0; r < radix; r++) {
      this.recurse(input, offset + r * stride, stride * radix, m, outRe, outIm, outOffset + r * m);
    }
    // Combine: X[k + q·m] = Σ_r W_n^{r(k + q·m)} · Y_r[k].
    const step = this.size / n; // W_n^j = W_size^{j·step}
    const re = this.scratchRe;
    const im = this.scratchIm;
    for (let k = 0; k < m; k++) {
      for (let q = 0; q < radix; q++) {
        const index = k + q * m;
        let sumRe = 0;
        let sumIm = 0;
        for (let r = 0; r < radix; r++) {
          const yRe = outRe[outOffset + r * m + k];
          const yIm = outIm[outOffset + r * m + k];
          const twiddle = ((r * index) % n) * step;
          const wRe = this.cos[twiddle];
          const wIm = this.sin[twiddle];
          sumRe += yRe * wRe - yIm * wIm;
          sumIm += yRe * wIm + yIm * wRe;
        }
        re[index] = sumRe;
        im[index] = sumIm;
      }
    }
    for (let index = 0; index < n; index++) {
      outRe[outOffset + index] = re[index];
      outIm[outOffset + index] = im[index];
    }
  }
}

// --- Mel filterbank --------------------------------------------------------------

/** librosa's Slaney mel scale (htk=False): linear to 1 kHz, logarithmic above. */
function hzToMel(hz: number): number {
  const linearStep = 200 / 3;
  if (hz < 1000) return hz / linearStep;
  return 1000 / linearStep + Math.log(hz / 1000) / (Math.log(6.4) / 27);
}

function melToHz(mel: number): number {
  const linearStep = 200 / 3;
  const minLogMel = 1000 / linearStep;
  if (mel < minLogMel) return mel * linearStep;
  return 1000 * Math.exp((Math.log(6.4) / 27) * (mel - minLogMel));
}

/** librosa.filters.mel(sr=16000, n_fft=400, n_mels=80): triangles, Slaney-normalized. */
export function createMelFilterbank(
  nMels = WHISPER_N_MELS,
  nFft = WHISPER_N_FFT,
  sampleRate = WHISPER_SAMPLE_RATE,
): Float32Array {
  const bins = nFft / 2 + 1;
  const fftFrequencies = Array.from({ length: bins }, (_, bin) => (bin * sampleRate) / nFft);
  const minMel = hzToMel(0);
  const maxMel = hzToMel(sampleRate / 2);
  const melPoints = Array.from({ length: nMels + 2 }, (_, index) =>
    melToHz(minMel + ((maxMel - minMel) * index) / (nMels + 1)),
  );

  const filters = new Float32Array(nMels * bins);
  for (let mel = 0; mel < nMels; mel++) {
    const lowerWidth = melPoints[mel + 1] - melPoints[mel];
    const upperWidth = melPoints[mel + 2] - melPoints[mel + 1];
    const norm = 2 / (melPoints[mel + 2] - melPoints[mel]);
    for (let bin = 0; bin < bins; bin++) {
      const lower = (fftFrequencies[bin] - melPoints[mel]) / lowerWidth;
      const upper = (melPoints[mel + 2] - fftFrequencies[bin]) / upperWidth;
      filters[mel * bins + bin] = Math.max(0, Math.min(lower, upper)) * norm;
    }
  }
  return filters;
}

// --- Log-mel spectrogram ---------------------------------------------------------

const PERIODIC_HANN = Float64Array.from(
  { length: WHISPER_N_FFT },
  (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / WHISPER_N_FFT),
);

let sharedFft: MixedRadixFft | null = null;
let sharedFilters: Float32Array | null = null;

/**
 * Features for one window: `samples` (at most 30 s at 16 kHz) zero-padded to 30 s.
 * Returns `[WHISPER_N_MELS, WHISPER_N_FRAMES]` row-major.
 */
export function whisperLogMel(samples: Float32Array): Float32Array {
  sharedFft ??= new MixedRadixFft(WHISPER_N_FFT);
  sharedFilters ??= createMelFilterbank();
  const fft = sharedFft;
  const filters = sharedFilters;

  // Zero-pad to the window, then reflect-pad half a frame each side (a centered STFT).
  const padded = new Float64Array(WHISPER_CHUNK_SAMPLES);
  padded.set(samples.subarray(0, WHISPER_CHUNK_SAMPLES));
  const half = WHISPER_N_FFT / 2;
  const signal = new Float64Array(WHISPER_CHUNK_SAMPLES + WHISPER_N_FFT);
  signal.set(padded, half);
  for (let index = 0; index < half; index++) {
    signal[half - 1 - index] = padded[index + 1];
    signal[half + WHISPER_CHUNK_SAMPLES + index] = padded[WHISPER_CHUNK_SAMPLES - 2 - index];
  }

  const frame = new Float64Array(WHISPER_N_FFT);
  const spectrumRe = new Float64Array(WHISPER_N_FFT);
  const spectrumIm = new Float64Array(WHISPER_N_FFT);
  const power = new Float64Array(N_BINS);
  const mel = new Float32Array(WHISPER_N_MELS * WHISPER_N_FRAMES);
  let peak = -Infinity;

  for (let t = 0; t < WHISPER_N_FRAMES; t++) {
    const start = t * WHISPER_HOP_LENGTH;
    for (let index = 0; index < WHISPER_N_FFT; index++) {
      frame[index] = signal[start + index] * PERIODIC_HANN[index];
    }
    fft.transformReal(frame, spectrumRe, spectrumIm);
    for (let bin = 0; bin < N_BINS; bin++) {
      power[bin] = spectrumRe[bin] * spectrumRe[bin] + spectrumIm[bin] * spectrumIm[bin];
    }
    for (let band = 0; band < WHISPER_N_MELS; band++) {
      let energy = 0;
      const row = band * N_BINS;
      for (let bin = 0; bin < N_BINS; bin++) energy += filters[row + bin] * power[bin];
      const value = Math.log10(Math.max(energy, 1e-10));
      mel[band * WHISPER_N_FRAMES + t] = value;
      if (value > peak) peak = value;
    }
  }

  const floor = peak - 8;
  for (let index = 0; index < mel.length; index++) {
    mel[index] = (Math.max(mel[index], floor) + 4) / 4;
  }
  return mel;
}

/** Exposed for tests: the DFT of a real signal. */
export function realDftForTest(input: Float64Array): { re: Float64Array; im: Float64Array } {
  const fft = new MixedRadixFft(input.length);
  const re = new Float64Array(input.length);
  const im = new Float64Array(input.length);
  fft.transformReal(input, re, im);
  return { re, im };
}

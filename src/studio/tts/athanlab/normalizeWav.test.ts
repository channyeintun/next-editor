import { describe, expect, it } from "vite-plus/test";
import { decodeWavPcm16, encodeWavPcm16, floatTo16BitPcm } from "../wav";
import { decodeAthanLabWav, normalizeAthanLabWav, resampleKaiserSinc } from "./normalizeWav";

type Encoding = "u8" | "s16" | "s24" | "s32" | "f32" | "f64";

const BYTES_PER_SAMPLE: Record<Encoding, number> = {
  u8: 1,
  s16: 2,
  s24: 3,
  s32: 4,
  f32: 4,
  f64: 8,
};

const GUID_TAIL = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

interface WavSpec {
  sampleRate: number;
  /** One array of full-scale samples per channel, all the same length. */
  channels: ArrayLike<number>[];
  encoding: Encoding;
  extensible?: boolean;
  /** Overrides the data chunk's declared size (a streamed WAV's placeholder). */
  declaredDataSize?: number;
  /** Raw bytes appended after the data chunk. */
  trailing?: Uint8Array;
}

function writeSample(view: DataView, offset: number, encoding: Encoding, value: number): void {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  switch (encoding) {
    case "u8":
      view.setUint8(offset, clamp(Math.round(value * 128 + 128), 0, 255));
      break;
    case "s16":
      view.setInt16(offset, clamp(Math.round(value * 0x8000), -0x8000, 0x7fff), true);
      break;
    case "s24": {
      const int = clamp(Math.round(value * 0x800000), -0x800000, 0x7fffff);
      view.setUint8(offset, int & 0xff);
      view.setUint8(offset + 1, (int >> 8) & 0xff);
      view.setUint8(offset + 2, (int >> 16) & 0xff);
      break;
    }
    case "s32":
      view.setInt32(offset, clamp(Math.round(value * 0x80000000), -0x80000000, 0x7fffffff), true);
      break;
    case "f32":
      view.setFloat32(offset, value, true);
      break;
    case "f64":
      view.setFloat64(offset, value, true);
      break;
  }
}

function buildWav({
  sampleRate,
  channels,
  encoding,
  extensible = false,
  declaredDataSize,
  trailing = new Uint8Array(0),
}: WavSpec): Uint8Array {
  const bytesPerSample = BYTES_PER_SAMPLE[encoding];
  const formatTag = encoding.startsWith("f") ? 3 : 1;
  const blockAlign = channels.length * bytesPerSample;
  const frames = channels[0].length;
  const dataBytes = frames * blockAlign;
  const fmtSize = extensible ? 40 : 16;
  const total = 12 + 8 + fmtSize + 8 + dataBytes + trailing.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, total - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : formatTag, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, bytesPerSample * 8, true); // valid bits
    view.setUint32(40, channels.length === 2 ? 0x3 : 0x4, true); // channel mask
    view.setUint16(44, formatTag, true);
    GUID_TAIL.forEach((byte, index) => view.setUint8(46 + index, byte));
  }
  const dataHeader = 12 + 8 + fmtSize;
  ascii(dataHeader, "data");
  view.setUint32(dataHeader + 4, declaredDataSize ?? dataBytes, true);
  for (let frame = 0; frame < frames; frame++) {
    channels.forEach((samples, channel) => {
      const offset = dataHeader + 8 + frame * blockAlign + channel * bytesPerSample;
      writeSample(view, offset, encoding, samples[frame]);
    });
  }
  bytes.set(trailing, dataHeader + 8 + dataBytes);
  return bytes;
}

function sine(
  frequency: number,
  sampleRate: number,
  seconds: number,
  amplitude: number,
): Float32Array {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return samples;
}

/** Amplitude of one frequency over a whole number of its periods (a single DFT bin). */
function amplitudeAt(samples: ArrayLike<number>, sampleRate: number, frequency: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    const angle = (2 * Math.PI * frequency * i) / sampleRate;
    re += samples[i] * Math.cos(angle);
    im -= samples[i] * Math.sin(angle);
  }
  return (2 * Math.hypot(re, im)) / samples.length;
}

/** The output's samples as floats, minus a second at each end (filter edges, trims). */
function middleSecond(wav: Uint8Array): Float64Array {
  const { pcm, sampleRate } = decodeWavPcm16(wav);
  const start = Math.floor((pcm.length - sampleRate) / 2);
  return Float64Array.from(pcm.subarray(start, start + sampleRate), (s) => s / 0x8000);
}

describe("decodeAthanLabWav", () => {
  const values = [0, 0.5, -0.5, 0.25, -0.75, 0.125];

  it.each<[Encoding, number]>([
    ["u8", 1 / 128],
    ["s16", 1 / 0x7fff],
    ["s24", 1e-6],
    ["s32", 1e-9],
    ["f32", 0],
    ["f64", 0],
  ])("decodes %s samples", (encoding, tolerance) => {
    const decoded = decodeAthanLabWav(
      buildWav({ sampleRate: 24_000, channels: [values], encoding }),
    );

    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.samples).toHaveLength(values.length);
    decoded.samples.forEach((sample, index) => {
      expect(Math.abs(sample - values[index])).toBeLessThanOrEqual(tolerance);
    });
  });

  it("reads 8-bit samples as unsigned around 128", () => {
    const bytes = buildWav({ sampleRate: 8_000, channels: [[0]], encoding: "u8" });
    bytes[bytes.length - 1] = 0;
    expect(decodeAthanLabWav(bytes).samples[0]).toBe(-1);
    bytes[bytes.length - 1] = 255;
    expect(decodeAthanLabWav(bytes).samples[0]).toBeCloseTo(127 / 128, 6);
  });

  it("averages any number of channels into mono", () => {
    const stereo = decodeAthanLabWav(
      buildWav({
        sampleRate: 48_000,
        channels: [
          [0.5, 0.25, -1],
          [0.1, -0.25, 0],
        ],
        encoding: "f32",
      }),
    );
    expect(stereo.samples).toHaveLength(3);
    [0.3, 0, -0.5].forEach((mono, index) => expect(stereo.samples[index]).toBeCloseTo(mono, 6));

    const sixChannels = decodeAthanLabWav(
      buildWav({
        sampleRate: 48_000,
        channels: [[0.6], [0.6], [0], [0], [0], [0]],
        encoding: "s24",
      }),
    );
    expect(sixChannels.samples[0]).toBeCloseTo(0.2, 6);
  });

  it("decodes WAVE_FORMAT_EXTENSIBLE PCM and float", () => {
    const pcm = decodeAthanLabWav(
      buildWav({
        sampleRate: 44_100,
        channels: [values, values],
        encoding: "s24",
        extensible: true,
      }),
    );
    expect(pcm.sampleRate).toBe(44_100);
    pcm.samples.forEach((sample, index) => expect(sample).toBeCloseTo(values[index], 6));

    const float = decodeAthanLabWav(
      buildWav({ sampleRate: 44_100, channels: [values], encoding: "f32", extensible: true }),
    );
    expect(Array.from(float.samples)).toEqual(values);
  });

  it("rejects an extensible sub-format that is neither PCM nor float", () => {
    const bytes = buildWav({
      sampleRate: 44_100,
      channels: [values],
      encoding: "s16",
      extensible: true,
    });
    bytes[44] = 0x02; // KSDATAFORMAT_SUBTYPE_ADPCM
    expect(() => decodeAthanLabWav(bytes)).toThrow(/sample format 0x0002/);
    bytes[44] = 0x01;
    bytes[50] = 0x11; // not the KSDATAFORMAT GUID family
    expect(() => decodeAthanLabWav(bytes)).toThrow(/sub-format is not PCM or IEEE float/);
  });

  describe("streamed WAV size placeholders", () => {
    // 3 whole stereo 16-bit frames plus one stray byte of a fourth.
    const channels = [
      [0.5, 0.25, -0.5],
      [0.5, 0.25, -0.5],
    ];
    const strayByte = new Uint8Array([0x7f]);

    it.each([
      ["0", 0],
      ["0xFFFFFFFF", 0xffffffff],
      ["past the end", 1_000_000],
    ])("reads a data size of %s as running to the end, in whole frames", (_, declared) => {
      const decoded = decodeAthanLabWav(
        buildWav({
          sampleRate: 24_000,
          channels,
          encoding: "s16",
          declaredDataSize: declared,
          trailing: strayByte,
        }),
      );
      expect(Array.from(decoded.samples, (s) => Math.round(s * 100) / 100)).toEqual([
        0.5, 0.25, -0.5,
      ]);
    });

    it("keeps a genuinely empty data chunk that another chunk follows", () => {
      const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 0x49, 0x4e, 0x46, 0x4f]);
      const bytes = buildWav({
        sampleRate: 24_000,
        channels: [[]],
        encoding: "s16",
        declaredDataSize: 0,
        trailing: list,
      });
      expect(decodeAthanLabWav(bytes).samples).toHaveLength(0);
    });
  });

  it("replaces NaN and infinite float samples with silence", () => {
    const decoded = decodeAthanLabWav(
      buildWav({
        sampleRate: 44_100,
        channels: [[0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5]],
        encoding: "f64",
      }),
    );
    expect(Array.from(decoded.samples)).toEqual([0.5, 0, 0, 0, 0.5]);
  });

  it("throws clear errors on malformed input", () => {
    const good = buildWav({ sampleRate: 24_000, channels: [values], encoding: "s16" });
    const view = (bytes: Uint8Array) => new DataView(bytes.buffer);
    const variant = (edit: (bytes: Uint8Array) => void) => {
      const bytes = good.slice();
      edit(bytes);
      return bytes;
    };

    expect(() => decodeAthanLabWav(new TextEncoder().encode("<html>busy</html>"))).toThrow(
      "Not a RIFF/WAVE file",
    );
    expect(() => decodeAthanLabWav(variant((b) => view(b).setUint16(20, 2, true)))).toThrow(
      "Unsupported WAV sample format 0x0002",
    );
    expect(() => decodeAthanLabWav(variant((b) => view(b).setUint16(34, 12, true)))).toThrow(
      "Unsupported WAV sample size: 12-bit integer PCM",
    );
    expect(() => decodeAthanLabWav(variant((b) => view(b).setUint16(22, 0, true)))).toThrow(
      "WAV declares no channels",
    );
    expect(() => decodeAthanLabWav(variant((b) => view(b).setUint32(24, 1, true)))).toThrow(
      "WAV sample rate 1 Hz is outside 8000–384000 Hz",
    );
    expect(() => decodeAthanLabWav(variant((b) => view(b).setUint16(32, 4, true)))).toThrow(
      "WAV block align 4 does not match 1 channel(s) of 16-bit samples",
    );
    expect(() =>
      decodeAthanLabWav(variant((b) => view(b).setUint32(12, 0x6b6e756a, true))),
    ).toThrow("WAV is missing its fmt chunk");
    expect(() => decodeAthanLabWav(good.slice(0, 36))).toThrow("WAV is missing its data chunk");
    expect(() => decodeAthanLabWav(good.slice(0, 30))).toThrow("WAV fmt chunk is truncated");
  });
});

describe("resampleKaiserSinc", () => {
  it("returns the input when the rates match", () => {
    const samples = sine(440, 48_000, 0.1, 0.5);
    expect(resampleKaiserSinc(samples, 48_000, 48_000)).toBe(samples);
  });

  it.each([
    [22_050, 48_000],
    [24_000, 48_000],
    [44_100, 48_000],
    [96_000, 48_000],
  ])("emits ceil(n · %i / %i) samples", (from, to) => {
    for (const n of [0, 1, 147, 1_000, 22_051]) {
      expect(resampleKaiserSinc(new Float32Array(n), from, to)).toHaveLength(
        Math.ceil((n * to) / from),
      );
    }
  });

  it("keeps DC at unity gain on every phase", () => {
    const resampled = resampleKaiserSinc(new Float32Array(44_100).fill(0.5), 44_100, 48_000);
    for (const sample of resampled.subarray(100, -100)) {
      expect(Math.abs(sample - 0.5)).toBeLessThan(1e-6);
    }
  });

  it("never emits NaN", () => {
    const { samples } = decodeAthanLabWav(
      buildWav({
        sampleRate: 22_050,
        channels: [Array.from({ length: 2_000 }, (_, i) => (i === 1_000 ? Number.NaN : 0.25))],
        encoding: "f32",
      }),
    );
    expect(resampleKaiserSinc(samples, 22_050, 48_000).every(Number.isFinite)).toBe(true);
  });

  // A 30 s dialog is resampled on the main thread before the next dialog
  // starts; this stays well under a second (about 0.1 s on a laptop).
  it("resamples a 30 s dialog quickly", () => {
    const samples = sine(440, 44_100, 30, 0.5);
    const startedAt = performance.now();
    const resampled = resampleKaiserSinc(samples, 44_100, 48_000);
    const elapsedMs = performance.now() - startedAt;

    expect(resampled).toHaveLength(30 * 48_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("normalizeAthanLabWav", () => {
  it("passes a PCM16 mono take at the target rate through unchanged", () => {
    const pcm = new Int16Array(4_800);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(0x7fff * (0.3 + 0.2 * Math.sin(i / 7)));
    }
    pcm[10] = -0x8000;
    pcm[11] = 0x7fff;
    const wav = encodeWavPcm16(pcm, 48_000);

    expect(normalizeAthanLabWav(wav, 48_000)).toEqual(wav);
  });

  it.each([22_050, 24_000, 44_100])(
    "keeps a 1 kHz tone's level within ±0.1 dB from %i Hz",
    (rate) => {
      const wav = encodeWavPcm16(floatTo16BitPcm(sine(1_000, rate, 3, 0.5)), rate);
      const normalized = normalizeAthanLabWav(wav, 48_000);

      expect(decodeWavPcm16(normalized).sampleRate).toBe(48_000);
      const middle = middleSecond(normalized);
      const levelDb = 20 * Math.log10(amplitudeAt(middle, 48_000, 1_000) / 0.5);
      expect(Math.abs(levelDb)).toBeLessThan(0.1);
    },
  );

  it("filters out a 30 kHz tone instead of aliasing it when halving 96 kHz", () => {
    const tone = sine(1_000, 96_000, 3, 0.25);
    const ultrasonic = sine(30_000, 96_000, 3, 0.5);
    const wav = encodeWavPcm16(
      floatTo16BitPcm(tone.map((sample, i) => sample + ultrasonic[i])),
      96_000,
    );

    const middle = middleSecond(normalizeAthanLabWav(wav, 48_000));

    // Undecimated, 30 kHz folds down to 48 − 30 = 18 kHz.
    const aliasDb = 20 * Math.log10(amplitudeAt(middle, 48_000, 18_000) / 0.5);
    expect(aliasDb).toBeLessThan(-40);
    expect(amplitudeAt(middle, 48_000, 1_000)).toBeCloseTo(0.25, 2);
  });

  it("mixes stereo to mono and resamples it", () => {
    const left = sine(1_000, 24_000, 3, 0.4);
    const right = sine(1_000, 24_000, 3, 0.2);
    const normalized = normalizeAthanLabWav(
      buildWav({ sampleRate: 24_000, channels: [left, right], encoding: "s16" }),
      48_000,
    );

    expect(amplitudeAt(middleSecond(normalized), 48_000, 1_000)).toBeCloseTo(0.3, 3);
  });

  it("trims lead-in and tail silence", () => {
    const voiced = sine(1_000, 24_000, 1, 0.5);
    const padded = new Float32Array(24_000 * 3);
    padded.set(voiced, 24_000);
    const normalized = normalizeAthanLabWav(
      encodeWavPcm16(floatTo16BitPcm(padded), 24_000),
      48_000,
    );

    const { pcm } = decodeWavPcm16(normalized);
    // 1 s of speech plus the 40 ms head pad and 150 ms tail pad, give or take
    // the filter's few samples of ring at each edge.
    expect(pcm.length / 48_000).toBeGreaterThan(1.18);
    expect(pcm.length / 48_000).toBeLessThan(1.21);
  });
});

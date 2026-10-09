import { describe, expect, it } from "vite-plus/test";
import {
  decodeWavPcm16,
  encodeWavPcm16,
  floatTo16BitPcm,
  stitchPcmSegments,
  trimSilence,
  validateDialogWav,
  wavDurationMs,
} from "./wav";

const RATE = 24_000;

function tonePcm(durationMs: number, value: number): Int16Array {
  return new Int16Array(Math.round((durationMs / 1000) * RATE)).fill(value);
}

function toneWav(durationMs: number, value: number): Uint8Array {
  return encodeWavPcm16(tonePcm(durationMs, value), RATE);
}

describe("wav codec", () => {
  it("round-trips PCM and reports exact durations", () => {
    const bytes = toneWav(1_500, 1234);
    const decoded = decodeWavPcm16(bytes);
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.pcm.length).toBe(36_000);
    expect(decoded.pcm[0]).toBe(1234);
    expect(wavDurationMs(bytes)).toBe(1_500);
  });

  it("clamps float samples into 16-bit range", () => {
    const pcm = floatTo16BitPcm(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(pcm[1]).toBe(0x7fff);
    expect(pcm[2]).toBe(-0x8000);
    expect(pcm[3]).toBe(0x7fff);
    expect(pcm[4]).toBe(-0x8000);
  });

  it("rejects a data chunk cut short", () => {
    expect(() => decodeWavPcm16(toneWav(100, 1).slice(0, 100))).toThrow(
      /data chunk is truncated: declares 4800 bytes, 56 present/,
    );
  });

  it("rejects non-PCM16-mono input", () => {
    const bytes = toneWav(100, 1);
    new DataView(bytes.buffer).setUint16(22, 2, true); // pretend stereo
    expect(() => decodeWavPcm16(bytes)).toThrow(/Unsupported WAV/);
  });
});

describe("trimSilence", () => {
  function padded(silenceHeadMs: number, voicedMs: number, silenceTailMs: number): Float32Array {
    const ms = (n: number) => Math.round((n / 1000) * RATE);
    const samples = new Float32Array(ms(silenceHeadMs) + ms(voicedMs) + ms(silenceTailMs));
    samples.fill(0.25, ms(silenceHeadMs), ms(silenceHeadMs) + ms(voicedMs));
    return samples;
  }

  it("trims model lead-in silence down to the head pad", () => {
    const trimmed = trimSilence(padded(640, 1000, 500), RATE);
    // 40ms head pad + 1000ms voice + 150ms tail pad.
    expect(trimmed.length).toBe(Math.round((1190 / 1000) * RATE));
    // Speech now starts at ~40ms instead of ~640ms.
    expect(Math.abs(trimmed[Math.round((45 / 1000) * RATE)])).toBeGreaterThan(0.1);
  });

  it("keeps short pads untouched", () => {
    const input = padded(20, 500, 100);
    expect(trimSilence(input, RATE).length).toBe(input.length);
  });

  it("returns all-silence audio unchanged", () => {
    const silence = new Float32Array(RATE);
    expect(trimSilence(silence, RATE)).toBe(silence);
  });
});

describe("stitchPcmSegments", () => {
  it("places segments at their offsets inside a silent canvas", () => {
    const stitched = stitchPcmSegments(
      [
        { pcm: tonePcm(500, 1000), startMs: 200 },
        { pcm: tonePcm(300, 2000), startMs: 1_000 },
      ],
      1_600,
      RATE,
    );
    const decoded = decodeWavPcm16(stitched);
    expect(decoded.pcm.length).toBe(Math.ceil(1.6 * RATE));

    const sampleAt = (ms: number) => decoded.pcm[Math.round((ms / 1000) * RATE)];
    expect(sampleAt(100)).toBe(0); // leading silence
    expect(sampleAt(400)).toBe(1000); // inside segment one
    expect(sampleAt(850)).toBe(0); // gap
    expect(sampleAt(1_100)).toBe(2000); // inside segment two
    expect(sampleAt(1_450)).toBe(0); // tail
  });

  it("writes exactly the WAV of the canvas it places the segments on", () => {
    const first = Int16Array.from({ length: 4_800 }, (_, index) => (index % 200) - 100);
    const second = tonePcm(250, -3_000);
    // Out of order on purpose: placement follows startMs, not argument order.
    const stitched = stitchPcmSegments(
      [
        { pcm: second, startMs: 700 },
        { pcm: first, startMs: 100 },
      ],
      1_000,
      RATE,
    );

    const canvas = new Int16Array(RATE);
    canvas.set(first, 2_400);
    canvas.set(second, 16_800);
    expect(stitched).toEqual(encodeWavPcm16(canvas, RATE));
  });

  it("fails loudly on overlap and overflow", () => {
    expect(() =>
      stitchPcmSegments(
        [
          { pcm: tonePcm(500, 1), startMs: 0 },
          { pcm: tonePcm(500, 1), startMs: 400 },
        ],
        2_000,
        RATE,
      ),
    ).toThrow(/overlaps/);

    expect(() =>
      stitchPcmSegments([{ pcm: tonePcm(500, 1), startMs: 1_800 }], 2_000, RATE),
    ).toThrow(/runs past/);
  });
});

describe("validateDialogWav", () => {
  it("returns the duration of voiced audio at the expected rate", () => {
    expect(validateDialogWav(toneWav(1_500, 1_000), RATE)).toBe(1_500);
  });

  it("rejects a wrong rate, no samples, silence, and malformed bytes", () => {
    expect(() => validateDialogWav(toneWav(500, 1_000), 48_000)).toThrow(
      "audio is 24000Hz, expected 48000Hz",
    );
    expect(() => validateDialogWav(toneWav(0, 0), RATE)).toThrow("audio has no samples");
    // Below the voiced threshold everywhere: what trimSilence treats as silence.
    expect(() => validateDialogWav(toneWav(500, 100), RATE)).toThrow("audio is silent");
    expect(() => validateDialogWav(new TextEncoder().encode("<html>oops</html>"), RATE)).toThrow(
      "Not a RIFF/WAVE file",
    );
  });
});

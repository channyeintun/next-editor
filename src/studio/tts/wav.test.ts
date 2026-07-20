import { describe, expect, it } from "vite-plus/test";
import {
  decodeWavPcm16,
  encodeWavPcm16,
  floatTo16BitPcm,
  stitchWavSegments,
  wavDurationMs,
} from "./wav";

const RATE = 24_000;

function toneWav(durationMs: number, value: number): Uint8Array {
  const samples = new Int16Array(Math.round((durationMs / 1000) * RATE)).fill(value);
  return encodeWavPcm16(samples, RATE);
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

  it("rejects non-PCM16-mono input", () => {
    const bytes = toneWav(100, 1);
    new DataView(bytes.buffer).setUint16(22, 2, true); // pretend stereo
    expect(() => decodeWavPcm16(bytes)).toThrow(/Unsupported WAV/);
  });
});

describe("stitchWavSegments", () => {
  it("places segments at their offsets inside a silent canvas", () => {
    const stitched = stitchWavSegments(
      [
        { bytes: toneWav(500, 1000), startMs: 200 },
        { bytes: toneWav(300, 2000), startMs: 1_000 },
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

  it("fails loudly on overlap, overflow, and rate mismatch", () => {
    expect(() =>
      stitchWavSegments(
        [
          { bytes: toneWav(500, 1), startMs: 0 },
          { bytes: toneWav(500, 1), startMs: 400 },
        ],
        2_000,
        RATE,
      ),
    ).toThrow(/overlaps/);

    expect(() =>
      stitchWavSegments([{ bytes: toneWav(500, 1), startMs: 1_800 }], 2_000, RATE),
    ).toThrow(/runs past/);

    expect(() =>
      stitchWavSegments(
        [{ bytes: encodeWavPcm16(new Int16Array(100), 16_000), startMs: 0 }],
        1_000,
        RATE,
      ),
    ).toThrow(/sample rate/);
  });
});

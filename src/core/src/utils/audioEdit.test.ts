import { describe, expect, it } from "vite-plus/test";
import { applyAudioEditToSamples, hasAudioEdit } from "./audioEdit";

// 1 kHz: one sample per millisecond keeps the spans readable.
const RATE = 1_000;
const ramp = (length: number) => Float32Array.from({ length }, (_, index) => index + 1);

describe("editing narration samples", () => {
  it("removes cut spans and keeps everything else in order", () => {
    const edited = applyAudioEditToSamples(ramp(100), RATE, {
      cuts: [
        { start: 10, end: 30 },
        { start: 60, end: 70 },
      ],
    });
    expect(edited).toHaveLength(70);
    // Away from the splices' short fades the samples are the originals.
    expect(edited[0]).toBe(1);
    expect(edited[20]).toBe(41);
    expect(edited[69]).toBe(100);
  });

  it("fades into and out of a splice instead of jumping", () => {
    const flat = new Float32Array(100).fill(1);
    const edited = applyAudioEditToSamples(flat, RATE, { cuts: [{ start: 40, end: 60 }] });
    expect(edited[39]).toBeLessThan(0.5);
    expect(edited[40]).toBeLessThan(0.5);
    expect(edited[30]).toBe(1);
    expect(edited[50]).toBe(1);
  });

  it("silences mutes in place", () => {
    const edited = applyAudioEditToSamples(new Float32Array(100).fill(1), RATE, {
      mutes: [{ start: 20, end: 50 }],
    });
    expect(edited).toHaveLength(100);
    expect(Array.from(edited.subarray(20, 50)).every((sample) => sample === 0)).toBe(true);
    expect(edited[5]).toBe(1);
    expect(edited[80]).toBe(1);
  });

  it("leaves the input untouched", () => {
    const samples = ramp(50);
    applyAudioEditToSamples(samples, RATE, {
      cuts: [{ start: 0, end: 10 }],
      mutes: [{ start: 20, end: 30 }],
    });
    expect(samples[25]).toBe(26);
  });

  it("knows an empty edit from a real one", () => {
    expect(hasAudioEdit(undefined)).toBe(false);
    expect(hasAudioEdit({ cuts: [] })).toBe(false);
    expect(hasAudioEdit({ mutes: [{ start: 0, end: 1 }] })).toBe(true);
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  clampVoiceSamples,
  MAX_SAMPLE_SECONDS,
  MIN_SAMPLE_SECONDS,
  VOICE_SAMPLE_RATE,
} from "./customVoices";

describe("clampVoiceSamples", () => {
  it("rejects samples shorter than the minimum", () => {
    const tooShort = new Float32Array(VOICE_SAMPLE_RATE * MIN_SAMPLE_SECONDS - 1);
    expect(() => clampVoiceSamples(tooShort, VOICE_SAMPLE_RATE)).toThrow(/too short/);
  });

  it("passes in-range samples through untouched", () => {
    const fiveSeconds = new Float32Array(VOICE_SAMPLE_RATE * 5);
    expect(clampVoiceSamples(fiveSeconds, VOICE_SAMPLE_RATE)).toBe(fiveSeconds);
  });

  it("trims anything past the maximum to the cap", () => {
    const long = new Float32Array(VOICE_SAMPLE_RATE * (MAX_SAMPLE_SECONDS + 30));
    expect(clampVoiceSamples(long, VOICE_SAMPLE_RATE)).toHaveLength(
      VOICE_SAMPLE_RATE * MAX_SAMPLE_SECONDS,
    );
  });
});

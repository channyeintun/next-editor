import { describe, expect, it } from "vite-plus/test";
import {
  FAST_EXPLAINER_CADENCE,
  compileTypingChunks,
  createSeededRandom,
  easeInOutCubic,
  totalTypingDurationMs,
} from "./cadence";

const SAMPLE = "func cube(v int) int {\n\treturn v * v * v\n}\n";

describe("compileTypingChunks", () => {
  it("is deterministic for the same seed and diverges across seeds", () => {
    const first = compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 42);
    const second = compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 42);
    const other = compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 43);

    expect(second).toEqual(first);
    expect(totalTypingDurationMs(other)).not.toBe(totalTypingDurationMs(first));
  });

  it("reassembles exactly the input text", () => {
    const chunks = compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 7);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(SAMPLE);
  });

  it("never spans a newline inside one chunk", () => {
    const chunks = compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 7);
    for (const chunk of chunks) {
      // A newline may only appear as the final character of a chunk.
      expect(chunk.text.indexOf("\n")).toBeOneOf([-1, chunk.text.length - 1]);
      expect(chunk.text.length).toBeLessThanOrEqual(FAST_EXPLAINER_CADENCE.maxChunkChars);
      expect(chunk.delayMs).toBeGreaterThan(0);
    }
  });

  it("returns no chunks for empty text", () => {
    expect(compileTypingChunks("", FAST_EXPLAINER_CADENCE, 1)).toEqual([]);
  });
});

describe("createSeededRandom", () => {
  it("produces a stable sequence in [0, 1)", () => {
    const first = createSeededRandom(123);
    const second = createSeededRandom(123);
    for (let i = 0; i < 100; i++) {
      const value = first();
      expect(value).toBe(second());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("easeInOutCubic", () => {
  it("clamps and hits its endpoints", () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

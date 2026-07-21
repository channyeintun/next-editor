import { describe, expect, it } from "vite-plus/test";
import {
  BLOCK_CADENCE,
  FAST_EXPLAINER_CADENCE,
  LINE_BY_LINE_CADENCE,
  NATURAL_CADENCE,
  compileTypingChunks,
  createSeededRandom,
  easeInOutCubic,
  totalTypingDurationMs,
} from "./cadence";

const SAMPLE = "func cube(v int) int {\n\treturn v * v * v\n}\n";

describe("compileTypingChunks (chars mode)", () => {
  it("is deterministic for the same seed and diverges across seeds", () => {
    const first = compileTypingChunks(SAMPLE, NATURAL_CADENCE, 42);
    const second = compileTypingChunks(SAMPLE, NATURAL_CADENCE, 42);
    const other = compileTypingChunks(SAMPLE, NATURAL_CADENCE, 43);

    expect(second).toEqual(first);
    expect(totalTypingDurationMs(other)).not.toBe(totalTypingDurationMs(first));
  });

  it("reassembles exactly the input text", () => {
    const chunks = compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 7);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(SAMPLE);
  });

  it("never spans a newline inside one chunk", () => {
    if (FAST_EXPLAINER_CADENCE.mode !== "chars") throw new Error("cadence changed mode");
    const chunks = compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 7);
    for (const chunk of chunks) {
      // A newline may only appear as the final character of a chunk.
      expect(chunk.text.indexOf("\n")).toBeOneOf([-1, chunk.text.length - 1]);
      expect(chunk.text.length).toBeLessThanOrEqual(FAST_EXPLAINER_CADENCE.maxChunkChars);
      expect(chunk.delayMs).toBeGreaterThan(0);
    }
  });

  it("natural is slower than fast-explainer for the same text", () => {
    const natural = totalTypingDurationMs(compileTypingChunks(SAMPLE, NATURAL_CADENCE, 7));
    const fast = totalTypingDurationMs(compileTypingChunks(SAMPLE, FAST_EXPLAINER_CADENCE, 7));
    expect(natural).toBeGreaterThan(fast);
  });

  it("returns no chunks for empty text", () => {
    expect(compileTypingChunks("", NATURAL_CADENCE, 1)).toEqual([]);
  });
});

describe("compileTypingChunks (lines mode)", () => {
  it("emits exactly one chunk per line — an incremental reveal", () => {
    const chunks = compileTypingChunks(SAMPLE, LINE_BY_LINE_CADENCE, 7);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(SAMPLE);
    for (const chunk of chunks) {
      expect(chunk.text.endsWith("\n")).toBe(true);
      expect(chunk.delayMs).toBeGreaterThan(0);
    }
  });

  it("gives longer lines longer pauses", () => {
    const cadence = { ...LINE_BY_LINE_CADENCE, jitter: 0 } as typeof LINE_BY_LINE_CADENCE;
    const chunks = compileTypingChunks("short\nmuch longer line of code here\n", cadence, 7);
    expect(chunks[1].delayMs).toBeGreaterThan(chunks[0].delayMs);
  });

  it("is deterministic per seed", () => {
    expect(compileTypingChunks(SAMPLE, LINE_BY_LINE_CADENCE, 5)).toEqual(
      compileTypingChunks(SAMPLE, LINE_BY_LINE_CADENCE, 5),
    );
  });
});

describe("compileTypingChunks (block mode)", () => {
  it("emits the whole insertion as one chunk after a beat", () => {
    const chunks = compileTypingChunks(SAMPLE, BLOCK_CADENCE, 7);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(SAMPLE);
    expect(chunks[0].delayMs).toBe(BLOCK_CADENCE.mode === "block" ? BLOCK_CADENCE.pauseMs : -1);
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

import { describe, expect, it } from "vite-plus/test";
import {
  WHISPER_TIME_PRECISION,
  applyWhisperLogitRules,
  argmax,
  detectLanguage,
  logSoftmaxAt,
  segmentWindow,
  type WhisperVocabulary,
} from "./whisperDecoding";

// A miniature vocabulary: text 0–9, end of text 10, prompt tokens 11–15, and
// timestamps 16–35 (<|0.00|> … <|0.38|>).
const TEXT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const EOT = 10;
const TS = 16;
const VOCAB: WhisperVocabulary = {
  sot: 11,
  startOfPrevious: 12,
  eot: EOT,
  transcribe: 13,
  noTimestamps: 14,
  noSpeech: 15,
  timestampBegin: TS,
  vocabSize: 36,
  languages: [
    { code: "en", id: 11 },
    { code: "fr", id: 12 },
  ],
  suppress: [9],
  beginSuppress: [0, EOT],
  maxInitialTimestampIndex: 5,
};
const ts = (step: number) => TS + step;

function allowedAfter(generated: number[], logits = new Float32Array(36)): number[] {
  applyWhisperLogitRules(logits, generated, VOCAB);
  return Array.from(logits.keys()).filter((id) => logits[id] !== -Infinity);
}

/** Logits favoring text and the end (so the timestamp-mass rule does not decide). */
function textLeaning(): Float32Array<ArrayBuffer> {
  const logits = new Float32Array(36).fill(-5);
  for (const id of [...TEXT, EOT]) logits[id] = 5;
  return logits;
}

describe("applyWhisperLogitRules", () => {
  it("opens a window with an early timestamp", () => {
    expect(allowedAfter([])).toEqual([ts(0), ts(1), ts(2), ts(3), ts(4), ts(5)]);
  });

  it("lets a segment's text run on, never suppressed tokens or prompt tokens", () => {
    const allowed = allowedAfter([ts(0), 1], textLeaning());
    expect(allowed).toContain(2);
    expect(allowed).toContain(EOT);
    expect(allowed).not.toContain(9); // suppressed
    for (let id = EOT + 1; id < TS; id++) expect(allowed).not.toContain(id);
  });

  it("forbids a timestamp earlier than the last one", () => {
    const allowed = allowedAfter([ts(3), 1], textLeaning());
    expect(allowed).not.toContain(ts(2));
    expect(allowed).toContain(ts(4));
  });

  it("follows a segment's closing timestamp with another timestamp or the end", () => {
    const allowed = allowedAfter([ts(0), 1, 2, ts(4)], textLeaning());
    expect(allowed.filter((id) => id < EOT)).toEqual([]);
    expect(allowed).toContain(EOT);
    expect(allowed).toContain(ts(4)); // the pair that starts the next segment
    expect(allowed).not.toContain(ts(3));
  });

  it("follows a pair of timestamps with text", () => {
    const allowed = allowedAfter([ts(0), 1, ts(4), ts(4)], textLeaning());
    expect(allowed.filter((id) => id >= TS)).toEqual([]);
    expect(allowed).toContain(1);
  });

  it("takes a timestamp when timestamps together outweigh the likeliest text", () => {
    const logits = new Float32Array(36).fill(-20);
    logits[1] = 2; // the likeliest text token
    // The 19 timestamps still open (<|0.00|> is behind): log(19) ≈ 2.9 > 2.
    for (let id = TS; id < 36; id++) logits[id] = 0;
    const allowed = allowedAfter([ts(0), 1], logits);
    expect(allowed.every((id) => id >= TS)).toBe(true);
  });
});

describe("the scoring helpers", () => {
  it("argmax finds the largest value within a length", () => {
    expect(argmax(Float32Array.from([1, 5, 3]))).toBe(1);
    expect(argmax(Float32Array.from([1, 2, 9]), 2)).toBe(1);
  });

  it("logSoftmaxAt is a log probability, ignoring masked tokens", () => {
    const logits = Float32Array.from([0, 0, -Infinity, Math.log(2)]);
    expect(Math.exp(logSoftmaxAt(logits, 3))).toBeCloseTo(0.5, 6);
    expect(Math.exp(logSoftmaxAt(logits, 0))).toBeCloseTo(0.25, 6);
  });

  it("detectLanguage picks the likeliest language token", () => {
    const logits = new Float32Array(36);
    logits[12] = 3;
    expect(detectLanguage(logits, VOCAB)).toBe("fr");
  });
});

describe("segmentWindow", () => {
  const seconds = (step: number) => step * WHISPER_TIME_PRECISION;

  it("splits closed segments and moves past the window when the last one closed", () => {
    const { segments, advance } = segmentWindow([ts(0), 1, 2, ts(5), ts(5), 3, ts(9)], 10, 30, TS);
    expect(segments).toEqual([
      { start: 10, end: 10 + seconds(5), tokens: [1, 2] },
      { start: 10 + seconds(5), end: 10 + seconds(9), tokens: [3] },
    ]);
    expect(advance).toBe(30);
  });

  it("drops speech that ran past the last closed segment, and resumes from there", () => {
    const { segments, advance } = segmentWindow([ts(0), 1, ts(5), ts(5), 3, 4], 0, 30, TS);
    expect(segments).toEqual([{ start: 0, end: seconds(5), tokens: [1] }]);
    expect(advance).toBeCloseTo(seconds(5), 10);
  });

  it("treats a window without a timestamp pair as one segment up to its last timestamp", () => {
    expect(segmentWindow([ts(0), 1, 2, ts(7)], 4, 30, TS)).toEqual({
      segments: [{ start: 4, end: 4 + seconds(7), tokens: [1, 2] }],
      advance: 30,
    });
    expect(segmentWindow([ts(0), 1, 2], 4, 12.5, TS)).toEqual({
      segments: [{ start: 4, end: 16.5, tokens: [1, 2] }],
      advance: 12.5,
    });
  });
});

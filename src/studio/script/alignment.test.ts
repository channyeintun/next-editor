import { describe, expect, it } from "vite-plus/test";
import {
  AlignmentError,
  buildCaptionTrack,
  estimateAlignment,
  markerTimeMs,
  sceneStartMs,
  validateAlignment,
} from "./alignment";
import { LEXICON_V1 } from "./lexicon";
import { extractNarration } from "./markers";

const NARRATION = [
  { sceneId: "one", narration: "Go functions live at the package level. [[mark:go]] Run it now." },
  { sceneId: "two", narration: "The five squares print first, and then the cube appears." },
];

describe("estimateAlignment", () => {
  it("covers every display token with monotonic, in-bounds spans", () => {
    const extracted = extractNarration(NARRATION);
    const alignment = estimateAlignment(extracted.tokens, 12_000, LEXICON_V1);

    expect(alignment.tokens).toHaveLength(extracted.tokens.length);
    validateAlignment(alignment, extracted.tokens);
    expect(alignment.tokens[0].startMs).toBeGreaterThan(0);
    expect(alignment.tokens.at(-1)!.endMs).toBeLessThan(12_000);
  });

  it("is deterministic", () => {
    const extracted = extractNarration(NARRATION);
    const first = estimateAlignment(extracted.tokens, 12_000, LEXICON_V1);
    const second = estimateAlignment(extracted.tokens, 12_000, LEXICON_V1);
    expect(second).toEqual(first);
  });

  it("rejects audio too short to carry the narration", () => {
    const extracted = extractNarration(NARRATION);
    expect(() => estimateAlignment(extracted.tokens, 100, LEXICON_V1)).toThrow(AlignmentError);
  });

  it("weights Burmese letters instead of treating each phrase as punctuation", () => {
    const extracted = extractNarration([
      { sceneId: "my", narration: "မင်္ဂလာပါ။ ဒီသင်ခန်းစာမှာ Go ကို လေ့လာမယ်။" },
    ]);
    const alignment = estimateAlignment(extracted.tokens, 8_000, LEXICON_V1, {
      leadMs: 0,
      tailMs: 0,
    });
    const firstDuration = alignment.tokens[0].endMs - alignment.tokens[0].startMs;
    const shortLatinDuration = alignment.tokens[3].endMs - alignment.tokens[3].startMs;

    expect(firstDuration).toBeGreaterThan(shortLatinDuration);
  });
});

describe("validateAlignment", () => {
  it("rejects overlapping and reordered spans", () => {
    const extracted = extractNarration([{ sceneId: "a", narration: "one two three" }]);
    const alignment = estimateAlignment(extracted.tokens, 5_000, LEXICON_V1);
    const broken = {
      ...alignment,
      tokens: alignment.tokens.map((token, index) =>
        index === 1 ? { ...token, startMs: 0 } : token,
      ),
    };
    expect(() => validateAlignment(broken, extracted.tokens)).toThrow(/overlaps/);
  });

  it("rejects token text drift (coverage mismatch)", () => {
    const extracted = extractNarration([{ sceneId: "a", narration: "one two" }]);
    const alignment = estimateAlignment(extracted.tokens, 5_000, LEXICON_V1);
    expect(() => validateAlignment(alignment, ["one", "TWO"])).toThrow(/narration has/);
    expect(() => validateAlignment(alignment, ["one"])).toThrow(/covers 2 tokens/);
  });
});

describe("markerTimeMs / sceneStartMs", () => {
  it("returns the start of the token a marker precedes", () => {
    const extracted = extractNarration(NARRATION);
    const alignment = estimateAlignment(extracted.tokens, 12_000, LEXICON_V1);
    const marker = extracted.markers.get("go")!;
    expect(markerTimeMs(alignment, marker)).toBe(alignment.tokens[marker.beforeTokenIndex].startMs);
  });

  it("scene start equals its first token's start", () => {
    const extracted = extractNarration(NARRATION);
    const alignment = estimateAlignment(extracted.tokens, 12_000, LEXICON_V1);
    expect(sceneStartMs(alignment, extracted, "two")).toBe(
      alignment.tokens[extracted.scenes[1].firstTokenIndex].startMs,
    );
  });
});

describe("buildCaptionTrack", () => {
  it("produces monotonic, non-overlapping cues that cover every token", () => {
    const extracted = extractNarration(NARRATION);
    const alignment = estimateAlignment(extracted.tokens, 12_000, LEXICON_V1);
    const track = buildCaptionTrack(alignment, extracted, { id: "t", language: "en" });

    const words = track.cues.flatMap((cue) => cue.words ?? []);
    expect(words.map((word) => word.text)).toEqual(extracted.tokens);

    for (let i = 0; i < track.cues.length; i++) {
      const cue = track.cues[i];
      expect(cue.end).toBeGreaterThan(cue.start);
      // Against the previous cue's end for i > 0; trivially true for the first.
      expect(cue.start).toBeGreaterThanOrEqual(i > 0 ? track.cues[i - 1].end : 0);
      for (const word of cue.words ?? []) {
        expect(word.start).toBeGreaterThanOrEqual(cue.start);
        expect(word.end).toBeLessThanOrEqual(cue.end);
      }
    }
  });

  it("breaks cues at scene boundaries", () => {
    const extracted = extractNarration(NARRATION);
    const alignment = estimateAlignment(extracted.tokens, 12_000, LEXICON_V1);
    const track = buildCaptionTrack(alignment, extracted, { id: "t", language: "en" });
    const sceneTwoFirstToken = extracted.tokens[extracted.scenes[1].firstTokenIndex];
    const cueStartingSceneTwo = track.cues.find((cue) => cue.text.startsWith(sceneTwoFirstToken));
    expect(cueStartingSceneTwo).toBeDefined();
  });

  it("breaks Burmese captions at the Burmese full stop", () => {
    const extracted = extractNarration([
      { sceneId: "my", narration: "ပထမစာကြောင်းပါ။ ဒုတိယစာကြောင်းပါ။" },
    ]);
    const alignment = estimateAlignment(extracted.tokens, 5_000, LEXICON_V1);
    const track = buildCaptionTrack(alignment, extracted, { id: "my", language: "my" });

    expect(track.cues).toHaveLength(2);
    expect(track.cues[0].text).toBe("ပထမစာကြောင်းပါ။");
  });
});

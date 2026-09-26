import { describe, expect, it } from "vite-plus/test";
import {
  addMediaCut,
  mapRecordingTimeToMediaTime,
  normalizeMediaSpans,
  totalMediaSpanLength,
} from "./mediaSpans";

describe("media spans", () => {
  it("sorts, merges and drops what is not a span", () => {
    expect(
      normalizeMediaSpans([
        { start: 500, end: 900 },
        { start: 100, end: 200 },
        { start: 200, end: 300 },
        { start: 800, end: 1_000 },
        { start: 50, end: 50 },
        null,
        7,
        { start: "a", end: 3 },
      ]),
    ).toEqual([
      { start: 100, end: 300 },
      { start: 500, end: 1_000 },
    ]);
  });

  it("adds a retake's cut, folding in every cut after its start", () => {
    const cuts = addMediaCut([{ start: 1_000, end: 2_000 }], { start: 4_000, end: 6_000 });
    expect(cuts).toEqual([
      { start: 1_000, end: 2_000 },
      { start: 4_000, end: 6_000 },
    ]);
    // Rewinding past both earlier retakes discards everything from there on.
    expect(addMediaCut(cuts, { start: 500, end: 7_000 })).toEqual([{ start: 500, end: 7_000 }]);
    expect(totalMediaSpanLength(cuts)).toBe(3_000);
  });

  it("maps recorded time onto the uncut media timeline", () => {
    const cuts = [
      { start: 1_000, end: 3_000 },
      { start: 5_000, end: 6_000 },
    ];
    expect(mapRecordingTimeToMediaTime(500, cuts)).toBe(500);
    // The moment the take resumed after the first retake: the media resumed at its end.
    expect(mapRecordingTimeToMediaTime(1_000, cuts)).toBe(3_000);
    expect(mapRecordingTimeToMediaTime(2_500, cuts)).toBe(4_500);
    expect(mapRecordingTimeToMediaTime(3_000, cuts)).toBe(6_000);
    expect(mapRecordingTimeToMediaTime(3_500, cuts)).toBe(6_500);
  });
});

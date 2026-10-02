import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  addMediaCut,
  mapRecordingTimeToMediaTime,
  normalizeMediaSpans,
  totalMediaSpanLength,
  type MediaSpan,
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

describe("media span laws", () => {
  // Small whole-number spans, so touching and overlapping spans are common. Some are
  // empty, reversed, or start before 0, and some entries are not spans at all.
  const arbSpan = fc.record({
    start: fc.integer({ min: -3, max: 24 }),
    end: fc.integer({ min: -3, max: 24 }),
  });
  const arbHeaderEntry = fc.oneof(
    { weight: 6, arbitrary: arbSpan },
    { weight: 1, arbitrary: fc.constantFrom(null, 7, { start: Number.NaN, end: 5 }) },
  );

  /** Whether `time` falls inside a half-open span, after the clamp to 0 that normalizing does. */
  function covers(entries: readonly unknown[], time: number): boolean {
    return entries.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const { start, end } = entry as MediaSpan;
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      return time >= Math.max(0, start) && time < Math.max(0, end);
    });
  }

  /** Every whole and half millisecond the generated spans can reach. */
  const SAMPLE_TIMES = Array.from({ length: 60 }, (_, index) => index / 2 - 4);

  it("normalizes to sorted, disjoint, non-empty spans that cover the same time", () => {
    fc.assert(
      fc.property(fc.array(arbHeaderEntry, { maxLength: 8 }), (entries) => {
        const spans = normalizeMediaSpans(entries);

        for (const span of spans) expect(span.end).toBeGreaterThan(span.start);
        // Touching spans are merged, so each span starts strictly after the one before ends.
        spans.slice(1).forEach((span, index) => {
          expect(span.start).toBeGreaterThan(spans[index].end);
        });
        for (const time of SAMPLE_TIMES) {
          expect(covers(spans, time), `at ${time}`).toBe(covers(entries, time));
        }
        expect(normalizeMediaSpans(spans)).toEqual(spans);
      }),
    );
  });

  // Mapping places recorded time on the media timeline and skips every cut, so the
  // media before the mapped point that was not cut away is exactly the recorded time.
  it("maps recorded time onto media time that no cut removed", () => {
    fc.assert(
      fc.property(
        fc.array(arbSpan, { maxLength: 6 }),
        fc.nat({ max: 40 }),
        fc.integer({ min: 1, max: 20 }),
        (entries, time, step) => {
          const cuts = normalizeMediaSpans(entries);
          const mediaTime = mapRecordingTimeToMediaTime(time, cuts);

          expect(covers(cuts, mediaTime)).toBe(false);
          let cutBefore = 0;
          for (const cut of cuts) {
            cutBefore += Math.max(0, Math.min(cut.end, mediaTime) - cut.start);
          }
          expect(mediaTime - cutBefore).toBe(time);
          // Later recorded time maps at least as much later: cuts only add media time.
          expect(mapRecordingTimeToMediaTime(time + step, cuts) - mediaTime).toBeGreaterThanOrEqual(
            step,
          );
        },
      ),
    );
  });
});

import { describe, expect, it } from "vite-plus/test";
import { suggestDeadAirCuts } from "./audioPeaks";

const BUCKET_MS = 100;

/** Loudness with speech (0.4) in the given seconds and room noise (0.005) elsewhere. */
const narration = (seconds: number, spoken: Array<[number, number]>) => {
  const peaks = new Float32Array((seconds * 1000) / BUCKET_MS).fill(0.005);
  for (const [from, to] of spoken) {
    peaks.fill(0.4, (from * 1000) / BUCKET_MS, (to * 1000) / BUCKET_MS);
  }
  return { peaks, bucketMs: BUCKET_MS, offsetMs: 0 };
};

describe("suggesting dead-air cuts", () => {
  it("cuts a long quiet stretch where nothing happened, leaving a little of it in", () => {
    const cuts = suggestDeadAirCuts({
      durationMs: 20_000,
      audio: narration(20, [
        [0, 5],
        [15, 20],
      ]),
      activityTimes: [],
    });
    expect(cuts).toEqual([{ start: 5_300, end: 14_700 }]);
  });

  it("keeps a quiet stretch where the author was typing", () => {
    const cuts = suggestDeadAirCuts({
      durationMs: 20_000,
      audio: narration(20, [
        [0, 5],
        [15, 20],
      ]),
      activityTimes: [7_000, 9_500, 12_000],
    });
    // Only the gaps between keystrokes long enough to count are left.
    expect(cuts).toEqual([]);
  });

  it("keeps short pauses", () => {
    const cuts = suggestDeadAirCuts({
      durationMs: 10_000,
      audio: narration(10, [
        [0, 4],
        [6, 10],
      ]),
      activityTimes: [],
    });
    expect(cuts).toEqual([]);
  });

  it("finds idle stretches in a take with no narration from its activity alone", () => {
    const cuts = suggestDeadAirCuts({
      durationMs: 12_000,
      activityTimes: [0, 1_000, 2_000, 9_000, 10_000],
    });
    expect(cuts).toEqual([{ start: 2_350, end: 8_700 }]);
  });

  it("suggests nothing for a duration that is not a real length", () => {
    for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(suggestDeadAirCuts({ durationMs, activityTimes: [] })).toEqual([]);
    }
  });

  // The duration comes from the recording's header, so a hostile file could size the
  // scan grid past what a typed array holds, or at gigabytes and minutes of looping
  // just under that. Only the first day of it is scanned.
  it("scans no more than a day of a take whose header claims longer", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const cuts = suggestDeadAirCuts({ durationMs: Number.MAX_VALUE, activityTimes: [] });
    expect(cuts).toEqual([{ start: 300, end: dayMs - 300 }]);
  });
});

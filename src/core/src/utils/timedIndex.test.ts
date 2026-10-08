import { describe, expect, it } from "vite-plus/test";
import {
  findFrameIndexAtTime,
  findTimedEventIndexAtOrBefore,
  type TimedReplayEvent,
} from "./timedIndex";

/** Events in order, built from `[timestamp, count]` runs. */
function eventsFromRuns(runs: Array<[timestamp: number, count: number]>): TimedReplayEvent[] {
  return runs.flatMap(([timestamp, count]) => Array.from({ length: count }, () => ({ timestamp })));
}

// 200 events over stamps 0..20. Long runs share one stamp, the way everything captured
// during a pause does, and some stamps (2, 5, 9, 14, 17, 19) have no event. From a hint
// at stamp 0, a target at stamp 15 is 148 events away: past the 128-event linear scan,
// so the binary search fallback runs too.
const MIXED_EVENTS = eventsFromRuns([
  [0, 5],
  [1, 1],
  [3, 12],
  [4, 30],
  [6, 2],
  [7, 1],
  [8, 20],
  [10, 9],
  [11, 1],
  [12, 40],
  [13, 3],
  [15, 25],
  [16, 1],
  [18, 30],
  [20, 20],
]);

const CASES: Array<[label: string, events: TimedReplayEvent[]]> = [
  ["no events", []],
  ["one event", [{ timestamp: 10 }]],
  ["one run of 150 events at a single stamp", eventsFromRuns([[7, 150]])],
  ["200 events with repeated stamps and gaps", MIXED_EVENTS],
];

describe("findTimedEventIndexAtOrBefore", () => {
  // The hint only makes the search faster: from any hint, including an out-of-range
  // one, the answer must be the last event at or before the time. Every hint and every
  // whole time from before the first stamp to after the last one is checked, so the
  // cold search, the short forward scan and both binary searches all run.
  it.each(CASES)("matches a linear scan from every hint (%s)", (_label, events) => {
    const mismatches: Array<{ time: number; hint: number; found: number; expected: number }> = [];

    for (let time = -1; time <= 21; time++) {
      const expected = events.findLastIndex((event) => event.timestamp <= time);
      for (let hint = -1; hint <= events.length; hint++) {
        const found = findTimedEventIndexAtOrBefore(events, time, hint);
        if (found !== expected) {
          mismatches.push({ time, hint, found, expected });
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  // Guards the fixture: if its runs change, the fallback must still be reached.
  it("puts stamp 15 past the linear scan limit from a hint at stamp 0", () => {
    expect(MIXED_EVENTS).toHaveLength(200);
    expect(MIXED_EVENTS.findLastIndex((event) => event.timestamp <= 15)).toBeGreaterThan(128);
  });
});

describe("findFrameIndexAtTime", () => {
  it("finds late frames across seeks and long jumps", () => {
    const frames = Array.from({ length: 10_000 }, (_, index) => ({ timestamp: index * 10 }));

    expect(findFrameIndexAtTime(frames, 98_760, -1)).toBe(9_876);
    expect(findFrameIndexAtTime(frames, 1_230, 9_876)).toBe(123);
    expect(findFrameIndexAtTime(frames, 77_770, 10)).toBe(7_777);
  });

  // Unlike the replay tracks' lookup, an editor always shows a frame: a time before the
  // first one resolves to it, from a cold search and from a forward cursor alike.
  it("resolves a time before the first frame to the first frame", () => {
    const frames = [{ timestamp: 100 }, { timestamp: 200 }];

    expect(findFrameIndexAtTime(frames, 50, -1)).toBe(0);
    expect(findFrameIndexAtTime(frames, 50, 1)).toBe(0);
    expect(findFrameIndexAtTime(frames, 50)).toBe(0);
    expect(findFrameIndexAtTime([], 50)).toBe(-1);
  });
});

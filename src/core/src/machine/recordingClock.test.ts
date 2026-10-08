import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  createRecordingClock,
  hasRecordingClockExclusions,
  isRecordingClockPaused,
  pauseRecordingClock,
  readRecordingClock,
  recordingTimeAtPerf,
  resumeRecordingClock,
  rewindRecordingClock,
  toRecordingWallTime,
} from "./recordingClock";

// A take started at perf 1000 / wall 50_000, paused from 3000 to 8000 (perf) and
// 52_000 to 57_000 (wall).
const START_PERF = 1_000;
const pausedOnce = () =>
  resumeRecordingClock(pauseRecordingClock(createRecordingClock(), 3_000, 52_000), 8_000, 57_000);

describe("recording clock", () => {
  it("runs from the take's origin until the first pause", () => {
    const clock = createRecordingClock();
    expect(readRecordingClock(clock, START_PERF, 1_750)).toBe(750);
    expect(isRecordingClockPaused(clock)).toBe(false);
    expect(hasRecordingClockExclusions(clock)).toBe(false);
  });

  it("stands still while paused", () => {
    const clock = pauseRecordingClock(createRecordingClock(), 3_000, 52_000);
    expect(isRecordingClockPaused(clock)).toBe(true);
    expect(readRecordingClock(clock, START_PERF, 3_000)).toBe(2_000);
    expect(readRecordingClock(clock, START_PERF, 9_000)).toBe(2_000);
  });

  it("skips a closed pause", () => {
    const clock = pausedOnce();
    expect(isRecordingClockPaused(clock)).toBe(false);
    expect(clock.exclusions).toEqual([
      { startPerf: 3_000, endPerf: 8_000, startWall: 52_000, endWall: 57_000 },
    ]);
    expect(readRecordingClock(clock, START_PERF, 8_000)).toBe(2_000);
    expect(readRecordingClock(clock, START_PERF, 9_500)).toBe(3_500);
  });

  it("maps past readings through the pauses they came before", () => {
    const clock = pausedOnce();
    expect(recordingTimeAtPerf(clock, START_PERF, 2_500)).toBe(1_500);
    // Inside the pause: the instant the clock stopped.
    expect(recordingTimeAtPerf(clock, START_PERF, 5_000)).toBe(2_000);
    expect(recordingTimeAtPerf(clock, START_PERF, 10_000)).toBe(4_000);
  });

  it("ignores a second pause or a resume of a running clock", () => {
    const paused = pauseRecordingClock(createRecordingClock(), 3_000, 52_000);
    expect(pauseRecordingClock(paused, 4_000, 53_000)).toBe(paused);
    const running = createRecordingClock();
    expect(resumeRecordingClock(running, 4_000, 53_000)).toBe(running);
  });

  it("counts a pause the wall clock reads backwards as empty there", () => {
    const clock = resumeRecordingClock(
      pauseRecordingClock(createRecordingClock(), 3_000, 52_000),
      8_000,
      51_000,
    );
    expect(clock.exclusions[0]).toMatchObject({
      startPerf: 3_000,
      endPerf: 8_000,
      startWall: 52_000,
      endWall: 52_000,
    });
    expect(toRecordingWallTime(clock, 52_500)).toBe(52_500);
  });

  it("rewinds to a moment it was running at and holds there", () => {
    // Running again from 8_000 (perf), then paused a second time at 10_000.
    const clock = pauseRecordingClock(pausedOnce(), 10_000, 59_000);
    // Rewind to 9_000: recorded 3_000, after the first pause.
    const rewound = rewindRecordingClock(clock, 9_000, 58_000);
    expect(rewound.exclusions).toHaveLength(1);
    expect(rewound.pausedAt).toEqual({ perf: 9_000, wall: 58_000 });
    expect(readRecordingClock(rewound, START_PERF, 20_000)).toBe(3_000);

    // Resuming turns the whole stretch since the safe point into one exclusion.
    const resumed = resumeRecordingClock(rewound, 20_000, 69_000);
    expect(readRecordingClock(resumed, START_PERF, 20_500)).toBe(3_500);
    expect(toRecordingWallTime(resumed, 69_500)).toBe(53_500);
  });

  it("drops exclusions a rewind to before them discards", () => {
    const rewound = rewindRecordingClock(pausedOnce(), 2_000, 51_000);
    expect(rewound.exclusions).toEqual([]);
    expect(readRecordingClock(rewound, START_PERF, 30_000)).toBe(1_000);
  });

  describe("wall-clock stamps", () => {
    it("leaves stamps before the first pause alone", () => {
      expect(toRecordingWallTime(pausedOnce(), 51_000)).toBe(51_000);
    });

    it("moves a stamp inside a pause to the moment it began", () => {
      expect(toRecordingWallTime(pausedOnce(), 54_000)).toBe(52_000);
    });

    it("takes a closed pause out of later stamps", () => {
      expect(toRecordingWallTime(pausedOnce(), 58_000)).toBe(53_000);
    });

    it("holds stamps from an open pause at its start", () => {
      const clock = pauseRecordingClock(pausedOnce(), 9_000, 58_000);
      // 58_000 is 1s of recorded wall time after the first pause's end.
      expect(toRecordingWallTime(clock, 60_000)).toBe(53_000);
      expect(toRecordingWallTime(clock, 57_500)).toBe(52_500);
    });

    it("keeps the stamp-to-recorded-time lead the same after a pause", () => {
      const clock = pausedOnce();
      // Before the pause: wall 51_000 is perf 2_000, recorded 1_000.
      const leadBefore =
        toRecordingWallTime(clock, 51_000) - recordingTimeAtPerf(clock, START_PERF, 2_000);
      // After it: wall 58_000 is perf 9_000, recorded 3_000.
      const leadAfter =
        toRecordingWallTime(clock, 58_000) - recordingTimeAtPerf(clock, START_PERF, 9_000);
      expect(leadAfter).toBe(leadBefore);
    });
  });
});

describe("recording clock laws", () => {
  // A take that runs and pauses in turn, with the wall clock moving with `performance.now()`.
  // Each step runs for `run` ms and then pauses for `pause` ms. The last pause may stay open.
  const START_WALL = 50_000;

  interface Take {
    steps: Array<{ run: number; pause: number }>;
    endsPaused: boolean;
  }

  const arbTake: fc.Arbitrary<Take> = fc.record({
    steps: fc.array(fc.record({ run: fc.nat({ max: 3_000 }), pause: fc.nat({ max: 3_000 }) }), {
      maxLength: 8,
    }),
    endsPaused: fc.boolean(),
  });

  const wallAt = (perf: number) => perf - START_PERF + START_WALL;

  function playTake({ steps, endsPaused }: Take) {
    let clock = createRecordingClock();
    let perf = START_PERF;
    /** The perf stretches the clock ran for. */
    const running: Array<{ start: number; end: number }> = [];
    /** Every perf reading at which the clock paused or ran again. */
    const edges: number[] = [];

    steps.forEach(({ run, pause }, index) => {
      running.push({ start: perf, end: perf + run });
      perf += run;
      clock = pauseRecordingClock(clock, perf, wallAt(perf));
      edges.push(perf);
      if (endsPaused && index === steps.length - 1) return;
      perf += pause;
      clock = resumeRecordingClock(clock, perf, wallAt(perf));
      edges.push(perf);
    });
    if (!isRecordingClockPaused(clock)) {
      running.push({ start: perf, end: Number.POSITIVE_INFINITY });
    }

    return { clock, running, edges };
  }

  /** The time the clock ran for between the take's start and `perf`. */
  function runningTimeBefore(running: Array<{ start: number; end: number }>, perf: number) {
    let total = 0;
    for (const { start, end } of running) total += Math.max(0, Math.min(end, perf) - start);
    return total;
  }

  type Reading = { offset: number } | { edge: number; nudge: number };

  // A reading anywhere in the take, or right next to a pause or a resume, where an
  // off-by-one would show.
  const arbReading: fc.Arbitrary<Reading> = fc.oneof(
    fc.record({ offset: fc.nat({ max: 60_000 }) }),
    fc.record({ edge: fc.nat(), nudge: fc.integer({ min: -2, max: 2 }) }),
  );

  function perfOf(reading: Reading, edges: number[]): number {
    if ("offset" in reading) return START_PERF + reading.offset;
    const edge = edges.length ? edges[reading.edge % edges.length] : START_PERF;
    return Math.max(START_PERF, edge + reading.nudge);
  }

  it("reads exactly the time the take was running", () => {
    fc.assert(
      fc.property(arbTake, arbReading, (take, reading) => {
        const { clock, running, edges } = playTake(take);
        const perf = perfOf(reading, edges);
        expect(recordingTimeAtPerf(clock, START_PERF, perf)).toBe(runningTimeBefore(running, perf));
      }),
    );
  });

  it("never runs backward or faster than real time", () => {
    fc.assert(
      fc.property(arbTake, arbReading, arbReading, (take, first, second) => {
        const { clock, edges } = playTake(take);
        const [earlier, later] = [perfOf(first, edges), perfOf(second, edges)].sort(
          (left, right) => left - right,
        );
        const gained =
          recordingTimeAtPerf(clock, START_PERF, later) -
          recordingTimeAtPerf(clock, START_PERF, earlier);
        expect(gained).toBeGreaterThanOrEqual(0);
        expect(gained).toBeLessThanOrEqual(later - earlier);
      }),
    );
  });

  // The rrweb preview events are placed by one constant offset from their wall stamps
  // (buildRrwebReplayEvents), so no number of pauses may change that offset.
  it("keeps the stamp-to-recorded-time lead the same after any number of pauses", () => {
    fc.assert(
      fc.property(arbTake, arbReading, (take, reading) => {
        const { clock, edges } = playTake(take);
        const perf = perfOf(reading, edges);
        const lead =
          toRecordingWallTime(clock, wallAt(perf)) - recordingTimeAtPerf(clock, START_PERF, perf);
        expect(lead).toBe(START_WALL);
      }),
    );
  });
});

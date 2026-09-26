import { describe, expect, it } from "vite-plus/test";
import {
  createRecordingClock,
  hasRecordingClockExclusions,
  isRecordingClockPaused,
  pauseRecordingClock,
  readRecordingClock,
  recordingTimeAtPerf,
  resumeRecordingClock,
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
    expect(clock.excludedPerfMs).toBe(5_000);
    expect(clock.excludedWallMs).toBe(5_000);
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
    expect(clock.excludedPerfMs).toBe(5_000);
    expect(clock.excludedWallMs).toBe(0);
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

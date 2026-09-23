import { describe, expect, it } from "vitest";
import type { DeltaFrame } from "./deltaTypes";
import {
  buildRecordingClusters,
  resolveClusterIndexForTime,
  splitFramesAtKeyframes,
} from "./recordingClusters";

const keyframe = (timestamp: number) => ({ isKeyframe: true, timestamp }) as unknown as DeltaFrame;
const delta = (timestamp: number) => ({ isKeyframe: false, timestamp }) as DeltaFrame;

describe("recording clusters", () => {
  it("splits frames into runs that each start at a keyframe", () => {
    const frames = [delta(5), keyframe(10), delta(20), keyframe(30)];

    expect(splitFramesAtKeyframes(frames)).toEqual([
      [frames[0]],
      [frames[1], frames[2]],
      [frames[3]],
    ]);
    expect(splitFramesAtKeyframes([])).toEqual([]);
  });

  it("ends each cluster where the next begins and the last at the take's duration", () => {
    expect(
      buildRecordingClusters([keyframe(0), delta(10), delta(40), keyframe(100), delta(150)], 300),
    ).toEqual([
      { index: 0, startTimeMs: 0, endTimeMs: 100, containsKeyframe: true },
      { index: 1, startTimeMs: 100, endTimeMs: 300, containsKeyframe: true },
    ]);
    // A take that opens on a delta, and a duration shorter than the last frame.
    expect(buildRecordingClusters([delta(5), keyframe(50)], 20)).toEqual([
      { index: 0, startTimeMs: 5, endTimeMs: 50, containsKeyframe: false },
      { index: 1, startTimeMs: 50, endTimeMs: 50, containsKeyframe: true },
    ]);
  });

  it("spans a take without frames with one cluster, or none when it has no duration", () => {
    expect(buildRecordingClusters([], 300)).toEqual([
      { index: 0, startTimeMs: 0, endTimeMs: 300, containsKeyframe: false },
    ]);
    expect(buildRecordingClusters([], 0)).toEqual([]);
  });

  it("finds the last cluster starting at or before a time", () => {
    const clusters = buildRecordingClusters([keyframe(10), keyframe(100)], 300);

    expect(resolveClusterIndexForTime(clusters, 50)).toBe(0);
    expect(resolveClusterIndexForTime(clusters, 100)).toBe(1);
    expect(resolveClusterIndexForTime(clusters, 0)).toBe(0);
    expect(resolveClusterIndexForTime([], 50)).toBe(0);
  });
});

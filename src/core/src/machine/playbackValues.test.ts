import { describe, expect, it } from "vite-plus/test";
import {
  normalizePlaybackSpeed,
  normalizePlaybackVolume,
  normalizeTimelineDuration,
  normalizeTimelineTime,
} from "./playbackValues";

describe("playback value normalization", () => {
  it("keeps speed inside the supported player range", () => {
    expect(normalizePlaybackSpeed(-1)).toBe(0.5);
    expect(normalizePlaybackSpeed(1.25)).toBe(1.25);
    expect(normalizePlaybackSpeed(10)).toBe(2);
    expect(normalizePlaybackSpeed(Number.NaN, 1.5)).toBe(1.5);
  });

  it("clamps volume and retains the prior value for non-finite input", () => {
    expect(normalizePlaybackVolume(-1)).toBe(0);
    expect(normalizePlaybackVolume(2)).toBe(1);
    expect(normalizePlaybackVolume(Number.NaN, 0.4)).toBe(0.4);
  });

  it("keeps durations and positions finite and non-negative", () => {
    expect(normalizeTimelineDuration(-1, 500)).toBe(500);
    expect(normalizeTimelineDuration(Number.NaN)).toBe(0);
    expect(normalizeTimelineTime(1_500, 1_000)).toBe(1_000);
    expect(normalizeTimelineTime(Number.NaN, 1_000, 250)).toBe(250);
  });
});

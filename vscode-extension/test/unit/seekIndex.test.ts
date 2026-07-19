import { describe, expect, it } from "vitest";
import { benchmarkFixtureConfigs, generateFixture } from "../../src/webview/player/fixtures";
import { bucketForTime, buildSeekIndex } from "../../src/storage/SeekIndexBuilder";

describe("SeekIndexBuilder", () => {
  it("buckets cover the whole session and reference valid state", () => {
    const config = benchmarkFixtureConfigs().find((c) => c.name === "small")!;
    const fixture = generateFixture(config);
    const index = buildSeekIndex(fixture.events, null);

    expect(index.version).toBe(1);
    expect(index.eventCount).toBe(fixture.events.length);
    expect(index.buckets.length).toBe(Math.floor(index.durationUs / index.bucketUs) + 1);

    let lastUpTo = -2;
    for (const bucket of index.buckets) {
      expect(bucket.upToSeq).toBeGreaterThanOrEqual(lastUpTo);
      lastUpTo = bucket.upToSeq;
      const event = bucket.upToSeq >= 0 ? fixture.events[bucket.upToSeq] : undefined;
      const eventAtOrBeforeBucket = event === undefined || event.tUs <= bucket.tUs;
      expect(eventAtOrBeforeBucket).toBe(true);
      const next = bucket.upToSeq >= 0 ? fixture.events[bucket.upToSeq + 1] : undefined;
      const nextStrictlyAfterBucket = next === undefined || next.tUs > bucket.tUs;
      expect(nextStrictlyAfterBucket).toBe(true);
    }

    // Late buckets know a checkpoint for every enrolled document.
    const lastBucket = index.buckets[index.buckets.length - 1]!;
    for (const documentId of fixture.documentIds) {
      const checkpointId = lastBucket.checkpoints[documentId];
      expect(checkpointId).toBeDefined();
      expect(fixture.checkpointBodies[checkpointId!]).toBeDefined();
    }
  });

  it("bucketForTime clamps and locates", () => {
    const config = benchmarkFixtureConfigs().find((c) => c.name === "edit-burst")!;
    const fixture = generateFixture(config);
    const index = buildSeekIndex(fixture.events, null);
    expect(bucketForTime(index, -5)).toBe(index.buckets[0]);
    expect(bucketForTime(index, Number.MAX_SAFE_INTEGER)).toBe(
      index.buckets[index.buckets.length - 1],
    );
    const mid = bucketForTime(index, Math.floor(index.durationUs / 2));
    expect(mid).not.toBeNull();
  });
});

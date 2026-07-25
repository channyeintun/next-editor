import { describe, expect, it } from "vitest";
import { getWhiteboardReplayResult } from "./whiteboard";
import type { WhiteboardElementJSON, WhiteboardEvent } from "../../whiteboard";

function element(id: string): WhiteboardElementJSON {
  return {
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  } as WhiteboardElementJSON;
}

/** n events, each introducing one new element at t = index * 10. */
function track(n: number): WhiteboardEvent[] {
  return Array.from({ length: n }, (_, index) => ({
    timestamp: index * 10,
    upserts: [element(`e${index}`)],
    removedIds: [],
  })) as WhiteboardEvent[];
}

describe("whiteboard replay", () => {
  it("reconstructs the exact cumulative scene at an index", () => {
    const events = track(5);
    const result = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 30,
      lastAppliedIndex: -1,
    });

    expect(result.nextIndex).toBe(3);
    // Every element up to and including index 3, and nothing after it.
    expect(result.stateToApply?.elements.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3"]);
  });

  it("folds only up to the requested index, not the whole track", () => {
    // The fold used to run over the entire array on every call while retaining
    // one fully-sorted scene per event — quadratic in the track length before
    // the first frame could render. Seeking to the second event must not pay
    // for the 50k that follow it.
    const events = track(50_000);
    const startedAt = performance.now();
    const result = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 10,
      lastAppliedIndex: -1,
    });
    const elapsed = performance.now() - startedAt;

    expect(result.nextIndex).toBe(1);
    expect(result.stateToApply?.elements.map((e) => e.id)).toEqual(["e0", "e1"]);
    // Folding all 50k would be seconds and gigabytes; a two-event prefix is
    // sub-millisecond. Generous bound so this is not timing-flaky.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("extends the cached fold as playback advances", () => {
    // Streaming playback appends in place and re-uses the same array, so the
    // prefix scan has to be extendable, not built once.
    const events = track(10);
    const first = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 10,
      lastAppliedIndex: -1,
    });
    expect(first.stateToApply?.elements).toHaveLength(2);

    const later = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 90,
      lastAppliedIndex: first.nextIndex,
    });
    expect(later.nextIndex).toBe(9);
    expect(later.stateToApply?.elements.map((e) => e.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `e${i}`),
    );
  });

  it("seeks backward to an already-folded index", () => {
    const events = track(10);
    getWhiteboardReplayResult({ whiteboardEvents: events, currentTime: 90, lastAppliedIndex: -1 });
    const back = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 20,
      lastAppliedIndex: 9,
    });

    expect(back.nextIndex).toBe(2);
    expect(back.stateToApply?.elements.map((e) => e.id)).toEqual(["e0", "e1", "e2"]);
  });
});

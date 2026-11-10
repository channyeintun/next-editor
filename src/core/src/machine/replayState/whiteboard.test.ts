import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  getWhiteboardReplayResult,
  getWhiteboardViewChangeIndex,
  withWhiteboardView,
} from "./whiteboard";
import {
  applyWhiteboardEvent,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
} from "../../whiteboard";

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

/**
 * n events at t = index * 10, each adding one element and removing the one added
 * `window` events before it, so every index has its own scene of bounded size.
 */
function slidingTrack(n: number, window: number): WhiteboardEvent[] {
  return Array.from({ length: n }, (_, index) => ({
    timestamp: index * 10,
    upserts: [element(`e${index}`)],
    removedIds: index >= window ? [`e${index - window}`] : [],
  })) as WhiteboardEvent[];
}

/** The scene at `index`, folded from the start with no cache. */
function foldDirectly(events: WhiteboardEvent[], index: number) {
  return events.slice(0, index + 1).reduce(applyWhiteboardEvent, EMPTY_WHITEBOARD_SCENE);
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

  // Only every 64th scene is kept, plus the last one resolved, so lookups away from
  // the last one fold forward from a checkpoint. Each must match a direct fold. A
  // sliding track keeps the cold fold to the end fast: with `track`, every event
  // re-sorts a scene that grows to 10,000 elements.
  it("resolves far, near-start and near-end seeks from sparse checkpoints", () => {
    const events = slidingTrack(10_000, 8);
    let lastAppliedIndex = -1;

    for (const index of [9_999, 5, 9_998]) {
      const result = getWhiteboardReplayResult({
        whiteboardEvents: events,
        currentTime: index * 10,
        lastAppliedIndex,
      });

      expect(result.nextIndex).toBe(index);
      expect(result.stateToApply?.elements.map((e) => e.id)).toEqual(
        foldDirectly(events, index).elements.map((e) => e.id),
      );
      lastAppliedIndex = result.nextIndex;
    }
  });

  it("keeps checkpoints exact as streamed events are appended", () => {
    // Streaming playback appends to the same array in place, so the checkpoints are
    // extended chunk by chunk rather than built once.
    const events = slidingTrack(300, 8);
    const streamed: WhiteboardEvent[] = [];
    for (let end = 50; end <= events.length; end += 50) {
      streamed.push(...events.slice(streamed.length, end));
      getWhiteboardReplayResult({
        whiteboardEvents: streamed,
        currentTime: (end - 1) * 10,
        lastAppliedIndex: -1,
      });
    }

    for (const index of [299, 127, 128, 63, 200, 255, 3]) {
      expect(
        getWhiteboardReplayResult({
          whiteboardEvents: streamed,
          currentTime: index * 10,
          lastAppliedIndex: -1,
        }).stateToApply?.elements.map((e) => e.id),
      ).toEqual(foldDirectly(events, index).elements.map((e) => e.id));
    }
  });
});

describe("whiteboard replay of a lesson file's own sizes", () => {
  // The scene size, the upserts in an event and the number of events all come from
  // the lesson file, and replay runs inside a state machine action on the viewer's
  // main thread. These count how often replay reads an element, so the bounds do not
  // depend on the machine.
  interface Reads {
    id: number;
    index: number;
  }

  /** A rectangle that counts the reads of its `id` and of its fractional `index`. */
  function countedElement(position: number, reads: Reads): WhiteboardElementJSON {
    const id = `r${position}`;
    const index = `a${String(position).padStart(6, "0")}`;
    return Object.defineProperties(element(id), {
      id: {
        enumerable: true,
        get() {
          reads.id += 1;
          return id;
        },
      },
      index: {
        enumerable: true,
        get() {
          reads.index += 1;
          return index;
        },
      },
    });
  }

  it("animates an event's upserts without searching the scene for each of them", () => {
    // Every element moves in the next event. Putting each in-between element back
    // used to search the scene from the front: half a scene per upsert, two million
    // id reads here, on every frame of the 150 ms before the event.
    const size = 2_000;
    const reads: Reads = { id: 0, index: 0 };
    const events: WhiteboardEvent[] = [
      {
        timestamp: 0,
        upserts: Array.from({ length: size }, (_, position) => countedElement(position, reads)),
      },
      {
        timestamp: 1_000,
        // Last element first, so each search runs past the ones not yet replaced.
        upserts: Array.from({ length: size }, (_, position) => ({
          ...element(`r${size - 1 - position}`),
          index: `a${String(size - 1 - position).padStart(6, "0")}`,
          version: 2,
          x: 3,
        })),
      },
    ];
    getWhiteboardReplayResult({ whiteboardEvents: events, currentTime: 500, lastAppliedIndex: -1 });
    reads.id = 0;

    const result = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 950,
      lastAppliedIndex: 0,
    });

    expect(result.nextIndex).toBe(0);
    expect(result.stateToApply?.elements.map((e) => [e.id, e.x])).toEqual(
      Array.from({ length: size }, (_, position) => [`r${position}`, 2]),
    );
    expect(reads.id).toBeLessThanOrEqual(4 * size);
  });

  it("folds many small events over a large scene without rebuilding the scene for each", () => {
    // Each event changes one element. Folding it used to rebuild and re-sort the
    // whole scene: events x elements, six million reads here.
    const size = 1_000;
    const count = 2_000;
    const reads: Reads = { id: 0, index: 0 };
    const events: WhiteboardEvent[] = [
      {
        timestamp: 0,
        upserts: Array.from({ length: size }, (_, position) => countedElement(position, reads)),
      },
      ...Array.from({ length: count }, (_, step) => ({
        timestamp: 10,
        upserts: [{ ...element("r0"), index: "a000000", version: step + 2, x: step + 1 }],
      })),
    ];
    getWhiteboardReplayResult({ whiteboardEvents: events, currentTime: 0, lastAppliedIndex: -1 });
    reads.id = 0;
    reads.index = 0;

    const result = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 20,
      lastAppliedIndex: 0,
    });

    expect(result.nextIndex).toBe(count);
    expect(result.stateToApply?.elements).toHaveLength(size);
    expect(result.stateToApply?.elements[0]).toMatchObject({ id: "r0", x: count });
    expect(reads.id + reads.index).toBeLessThanOrEqual(8 * (size + count));
  });

  it("folds a track that only grows without re-sorting it for each event", () => {
    // Each event adds an element, so the scene is as long as the track. Kept scenes
    // used to come every 64 events whatever their size: n²/128 slots held, and n²/2
    // reads on the way to the end.
    const count = 4_000;
    const reads: Reads = { id: 0, index: 0 };
    const events: WhiteboardEvent[] = Array.from({ length: count }, (_, position) => ({
      timestamp: position * 10,
      upserts: [countedElement(position, reads)],
    }));

    const end = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: count * 10,
      lastAppliedIndex: -1,
    });
    expect(end.stateToApply?.elements.map((e) => e.id)).toEqual(
      Array.from({ length: count }, (_, position) => `r${position}`),
    );
    expect(reads.id + reads.index).toBeLessThanOrEqual(16 * count);

    // A seek back folds from a kept scene, in work bounded by the scene it lands on.
    reads.id = 0;
    reads.index = 0;
    const back = getWhiteboardReplayResult({
      whiteboardEvents: events,
      currentTime: 2_999 * 10,
      lastAppliedIndex: end.nextIndex,
    });
    expect(back.stateToApply?.elements).toHaveLength(3_000);
    expect(reads.id + reads.index).toBeLessThanOrEqual(16 * 3_000);
  });

  it("shows the scene a direct fold shows, wherever the playhead goes", () => {
    const arbStep = fc.record(
      {
        upserts: fc.array(
          fc.record(
            { id: fc.constantFrom("a", "b", "c", "d"), index: fc.constantFrom("a0", "a1") },
            { requiredKeys: ["id"] },
          ),
          { maxLength: 3 },
        ),
        removedIds: fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 1 }),
        isOpen: fc.boolean(),
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(
        fc.array(arbStep, { minLength: 1, maxLength: 300 }),
        fc.array(fc.nat({ max: 299 }), { minLength: 1, maxLength: 12 }),
        fc.nat({ max: 300 }),
        (steps, seeks, streamedFirst) => {
          let version = 0;
          const all: WhiteboardEvent[] = steps.map(({ upserts, ...step }, index) => ({
            ...step,
            // Far enough apart that no seek lands in an animation window.
            timestamp: index * 1_000,
            ...(upserts
              ? {
                  upserts: upserts.map((upsert) => ({
                    ...element(upsert.id),
                    ...upsert,
                    version: (version += 1),
                  })),
                }
              : {}),
          }));
          // The track streams in: the rest is appended in place after the first seek.
          const events = all.slice(0, Math.max(1, streamedFirst));

          let lastAppliedIndex = -1;
          seeks.forEach((seek, turn) => {
            if (turn === 1) events.push(...all.slice(events.length));
            const index = seek % events.length;
            const result = getWhiteboardReplayResult({
              whiteboardEvents: events,
              currentTime: index * 1_000,
              lastAppliedIndex,
            });

            expect(result.nextIndex).toBe(index);
            // A seek that stays on the applied event has nothing new to show.
            expect(result.stateToApply).toEqual(
              index === lastAppliedIndex ? undefined : foldDirectly(all, index),
            );
            lastAppliedIndex = index;
          });
        },
      ),
    );
  });
});

describe("getWhiteboardViewChangeIndex", () => {
  it("marks where the board was opened, closed, maximized or restored, not where it was drawn on", () => {
    const events: WhiteboardEvent[] = [
      { timestamp: 0, upserts: [element("a")] },
      { timestamp: 10, isOpen: true },
      { timestamp: 20, upserts: [element("b")] },
      { timestamp: 30, isMaximized: true },
      { timestamp: 40, view: { scrollX: 5, scrollY: 0, zoom: 1 } },
      { timestamp: 50, isOpen: false },
    ];

    expect(events.map((_, index) => getWhiteboardViewChangeIndex(events, index))).toEqual([
      -1, 1, 1, 3, 3, 5,
    ]);
    expect(getWhiteboardViewChangeIndex(events, -1)).toBe(-1);
  });

  it("does not count an event that sets the view it already had", () => {
    const events: WhiteboardEvent[] = [
      { timestamp: 0, isOpen: true },
      { timestamp: 10, isOpen: true, upserts: [element("a")] },
      { timestamp: 20, isMaximized: false },
    ];

    expect(getWhiteboardViewChangeIndex(events, 2)).toBe(0);
  });

  it("keeps up with a track that streams in", () => {
    const events: WhiteboardEvent[] = [{ timestamp: 0, isOpen: true }];
    expect(getWhiteboardViewChangeIndex(events, 0)).toBe(0);

    events.push({ timestamp: 10, upserts: [element("a")] }, { timestamp: 20, isOpen: false });

    expect(getWhiteboardViewChangeIndex(events, 1)).toBe(0);
    expect(getWhiteboardViewChangeIndex(events, 2)).toBe(2);
  });
});

describe("withWhiteboardView", () => {
  it("shows a scene the way the viewer has the board, keeping its content", () => {
    const scene = applyWhiteboardEvent(EMPTY_WHITEBOARD_SCENE, {
      timestamp: 0,
      upserts: [element("a")],
      isOpen: true,
    });

    const shown = withWhiteboardView(scene, { isOpen: false, isMaximized: true });

    expect(shown).toEqual({ ...scene, isOpen: false, isMaximized: true });
    expect(shown.elements).toBe(scene.elements);
    expect(scene.isOpen).toBe(true);
  });

  it("returns the same object for the same scene and view, so re-applying it is free", () => {
    const view = { isOpen: true, isMaximized: false };
    const shown = withWhiteboardView(EMPTY_WHITEBOARD_SCENE, view);

    expect(withWhiteboardView(EMPTY_WHITEBOARD_SCENE, view)).toBe(shown);
    expect(withWhiteboardView(EMPTY_WHITEBOARD_SCENE, EMPTY_WHITEBOARD_SCENE)).toBe(
      EMPTY_WHITEBOARD_SCENE,
    );
  });
});

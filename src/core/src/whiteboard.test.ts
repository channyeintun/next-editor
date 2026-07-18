import { describe, expect, it } from "vite-plus/test";
import {
  areWhiteboardViewsEqual,
  deriveWhiteboardDelta,
  rebaseWhiteboardDelta,
  snapshotWhiteboardDelta,
  type WhiteboardElementJSON,
} from "./whiteboard";

function makeElement(overrides: Partial<WhiteboardElementJSON> = {}): WhiteboardElementJSON {
  return {
    id: "el-1",
    version: 1,
    versionNonce: 111,
    isDeleted: false,
    type: "freedraw",
    ...overrides,
  };
}

describe("deriveWhiteboardDelta", () => {
  it("treats every element as an upsert when there is no previous state", () => {
    const elements = [makeElement({ id: "a" }), makeElement({ id: "b" })];
    const delta = deriveWhiteboardDelta([], elements);

    expect(delta.upserts).toEqual(elements);
    expect(delta.removedIds).toEqual([]);
  });

  it("only upserts elements whose version changed", () => {
    const previous = [makeElement({ id: "a", version: 1 }), makeElement({ id: "b", version: 1 })];
    const next = [makeElement({ id: "a", version: 1 }), makeElement({ id: "b", version: 2 })];

    const delta = deriveWhiteboardDelta(previous, next);

    expect(delta.upserts).toEqual([next[1]]);
    expect(delta.removedIds).toEqual([]);
  });

  it("upserts the deterministic winner when only versionNonce changes", () => {
    const previous = [makeElement({ id: "a", version: 2, versionNonce: 111 })];
    const next = [makeElement({ id: "a", version: 2, versionNonce: 999 })];

    const delta = deriveWhiteboardDelta(previous, next);

    expect(delta.upserts).toEqual(next);
    expect(delta.removedIds).toEqual([]);
  });

  it("reports hard-removed ids that vanished from the array", () => {
    const previous = [makeElement({ id: "a" }), makeElement({ id: "b" })];
    const next = [makeElement({ id: "a" })];

    const delta = deriveWhiteboardDelta(previous, next);

    expect(delta.upserts).toEqual([]);
    expect(delta.removedIds).toEqual(["b"]);
  });

  it("treats a soft-deleted element as an upsert, not a removal", () => {
    const previous = [makeElement({ id: "a", version: 1, isDeleted: false })];
    const next = [makeElement({ id: "a", version: 2, isDeleted: true })];

    const delta = deriveWhiteboardDelta(previous, next);

    expect(delta.upserts).toEqual([next[0]]);
    expect(delta.removedIds).toEqual([]);
  });

  it("returns no changes when nothing changed", () => {
    const elements = [makeElement({ id: "a" }), makeElement({ id: "b" })];
    const delta = deriveWhiteboardDelta(elements, elements);

    expect(delta.upserts).toEqual([]);
    expect(delta.removedIds).toEqual([]);
  });

  it("handles a new element appearing alongside unchanged ones", () => {
    const previous = [makeElement({ id: "a", version: 1 })];
    const next = [makeElement({ id: "a", version: 1 }), makeElement({ id: "c", version: 1 })];

    const delta = deriveWhiteboardDelta(previous, next);

    expect(delta.upserts).toEqual([next[1]]);
    expect(delta.removedIds).toEqual([]);
  });
});

describe("snapshotWhiteboardDelta", () => {
  it("records each flush of an element Excalidraw mutates in place, without drifting", () => {
    // Excalidraw's mutation model: ONE object per element, mutated in place as
    // the stroke grows (points appended, version bumped per pointermove).
    const liveElement = makeElement({ id: "a", version: 1, points: [[0, 0]] });

    const firstFlush = snapshotWhiteboardDelta([], [liveElement]);
    expect(firstFlush).not.toBeNull();
    expect(firstFlush?.upserts.map((element) => element.id)).toEqual(["a"]);

    // The stroke continues: same object, new points, bumped version.
    liveElement.version = 7;
    liveElement.points = [
      [0, 0],
      [1, 1],
    ];

    // The second flush must still see the change — with live references the
    // previous state would be the same object and the diff would find nothing.
    const secondFlush = snapshotWhiteboardDelta(firstFlush!.nextElements, [liveElement]);
    expect(secondFlush).not.toBeNull();
    expect(secondFlush?.upserts[0].version).toBe(7);

    // And the first flush's recorded upsert must have kept its intermediate
    // state rather than aliasing the live element's final state.
    expect(firstFlush?.upserts[0].version).toBe(1);
    expect(firstFlush?.upserts[0].points).toEqual([[0, 0]]);
  });

  it("returns null when no element changed", () => {
    const liveElement = makeElement({ id: "a", version: 1 });
    const firstFlush = snapshotWhiteboardDelta([], [liveElement]);

    expect(snapshotWhiteboardDelta(firstFlush!.nextElements, [liveElement])).toBeNull();
  });

  it("keeps the live array's order in nextElements, reusing unchanged snapshots", () => {
    const liveA = makeElement({ id: "a", version: 1 });
    const liveB = makeElement({ id: "b", version: 1 });
    const firstFlush = snapshotWhiteboardDelta([], [liveA, liveB]);

    // b changes and moves to the front (z-order change).
    liveB.version = 2;
    const secondFlush = snapshotWhiteboardDelta(firstFlush!.nextElements, [liveB, liveA]);

    expect(secondFlush?.nextElements.map((element) => element.id)).toEqual(["b", "a"]);
    // Unchanged element keeps its previous snapshot identity (no re-clone).
    expect(secondFlush?.nextElements[1]).toBe(firstFlush!.nextElements[0]);
    // Changed element is a fresh clone, not the live reference.
    expect(secondFlush?.nextElements[0]).not.toBe(liveB);
  });
});

describe("rebaseWhiteboardDelta", () => {
  it("preserves a remote element that arrived during a local capture window", () => {
    const base = [makeElement({ id: "local", index: "a0" })];
    const liveLocal = makeElement({ id: "local", version: 2, index: "a0" });
    const delta = snapshotWhiteboardDelta(base, [liveLocal]);
    const remote = makeElement({ id: "remote", index: "a1" });

    expect(rebaseWhiteboardDelta([...base, remote], delta!)).toEqual([liveLocal, remote]);
  });
});

describe("areWhiteboardViewsEqual", () => {
  it("is true for the same reference", () => {
    const view = { scrollX: 1, scrollY: 2, zoom: 1 };
    expect(areWhiteboardViewsEqual(view, view)).toBe(true);
  });

  it("is true for structurally equal views", () => {
    expect(
      areWhiteboardViewsEqual(
        { scrollX: 1, scrollY: 2, zoom: 1 },
        { scrollX: 1, scrollY: 2, zoom: 1 },
      ),
    ).toBe(true);
  });

  it("is false when any field differs", () => {
    expect(
      areWhiteboardViewsEqual(
        { scrollX: 1, scrollY: 2, zoom: 1 },
        { scrollX: 1, scrollY: 2, zoom: 1.5 },
      ),
    ).toBe(false);
  });

  it("is false when either side is undefined", () => {
    expect(areWhiteboardViewsEqual(undefined, { scrollX: 0, scrollY: 0, zoom: 1 })).toBe(false);
    expect(areWhiteboardViewsEqual({ scrollX: 0, scrollY: 0, zoom: 1 }, undefined)).toBe(false);
  });
});

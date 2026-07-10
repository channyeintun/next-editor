import { describe, expect, it } from "vite-plus/test";
import {
  areWhiteboardViewsEqual,
  deriveWhiteboardDelta,
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

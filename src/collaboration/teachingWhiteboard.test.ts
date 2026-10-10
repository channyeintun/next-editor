import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
  validateCollaborationTeachingDocument,
} from "./teachingDocument";
import { element, freedraw } from "./teachingTestFixtures";
import { applyCollaborationWhiteboardDelta } from "./teachingWhiteboard";

describe("collaboration teaching whiteboard", () => {
  it("refuses a whiteboard delta before the room's teaching surfaces exist", () => {
    const doc = new Y.Doc();

    expect(() => applyCollaborationWhiteboardDelta(doc, { upserts: [element("shape")] })).toThrow(
      "The room teaching surfaces are not initialized",
    );
    doc.getMap("project").set("teaching", new Y.Map());
    expect(() => applyCollaborationWhiteboardDelta(doc, { upserts: [element("shape")] })).toThrow(
      "The room teaching surfaces are not initialized",
    );

    doc.destroy();
  });

  it("returns the current winner when a delta's candidate loses", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [],
      whiteboardElements: [element("shape", 3)],
    });

    const { elements, accepted } = applyCollaborationWhiteboardDelta(doc, {
      upserts: [element("shape", 2)],
    });

    expect(elements).toEqual([expect.objectContaining({ id: "shape", version: 3 })]);
    expect(projectCollaborationTeachingDocument(doc).whiteboardElements).toEqual(elements);
    // Another client's version won, so the canvas does not show the result.
    expect(accepted).toBe(false);

    doc.destroy();
  });

  it("accepts a delta whose upserts win and whose removals take", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [],
      whiteboardElements: [element("shape", 1, "a0"), element("note", 1, "a1")],
    });

    expect(
      applyCollaborationWhiteboardDelta(doc, {
        upserts: [element("shape", 2, "a0")],
        removedIds: ["note"],
      }).accepted,
    ).toBe(true);
    // An ID the room never had is already absent.
    expect(applyCollaborationWhiteboardDelta(doc, { removedIds: ["missing"] }).accepted).toBe(true);

    doc.destroy();
  });

  it("accepts an upsert equal to the stored winner, whatever its key order", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [],
      whiteboardElements: [element("shape", 3)],
    });
    const reordered = Object.fromEntries(Object.entries(element("shape", 3)).reverse());

    expect(
      applyCollaborationWhiteboardDelta(doc, {
        upserts: [reordered as ReturnType<typeof element>],
      }).accepted,
    ).toBe(true);

    doc.destroy();
  });

  it("does not accept a removal that a newer upsert of the same element overrides", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [element("shape")] });

    const { elements, accepted } = applyCollaborationWhiteboardDelta(doc, {
      upserts: [element("shape", 5)],
      removedIds: ["shape"],
    });

    expect(elements).toEqual([expect.objectContaining({ id: "shape", version: 5 })]);
    expect(accepted).toBe(false);

    doc.destroy();
  });

  it("keeps the longest progressive freehand snapshot at one Excalidraw version", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [] });
    const partial = freedraw("stroke", [[0, 0]]);
    const completed = freedraw("stroke", [
      [0, 0],
      [1, 1],
      [2, 2],
    ]);

    applyCollaborationWhiteboardDelta(doc, { upserts: [partial] });
    const longer = applyCollaborationWhiteboardDelta(doc, { upserts: [completed] });
    expect(longer.elements[0]?.points).toEqual(completed.points);
    expect(longer.accepted).toBe(true);
    const shorter = applyCollaborationWhiteboardDelta(doc, { upserts: [partial] });
    expect(shorter.elements[0]?.points).toEqual(completed.points);
    expect(shorter.accepted).toBe(false);

    doc.destroy();
  });

  it("keeps hard-removal tombstones through concurrent stale updates", () => {
    const seed = new Y.Doc();
    seedCollaborationTeachingDocument(seed, {
      slides: [],
      whiteboardElements: [element("shape", 1)],
    });
    const left = new Y.Doc();
    const right = new Y.Doc();
    const snapshot = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(left, snapshot);
    Y.applyUpdate(right, snapshot);

    applyCollaborationWhiteboardDelta(left, { removedIds: ["shape"] });
    applyCollaborationWhiteboardDelta(right, { upserts: [element("shape", 2)] });
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));

    expect(validateCollaborationTeachingDocument(left).projection.whiteboardElements).toEqual([]);
    expect(projectCollaborationTeachingDocument(right).whiteboardElements).toEqual([]);

    applyCollaborationWhiteboardDelta(left, { upserts: [element("shape", 3)] });
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(projectCollaborationTeachingDocument(right).whiteboardElements).toEqual([
      expect.objectContaining({ id: "shape", version: 3 }),
    ]);

    seed.destroy();
    left.destroy();
    right.destroy();
  });

  it("reuses parsed whiteboard candidates without skipping the record identity check", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [element("shape")] });
    const [first] = projectCollaborationTeachingDocument(doc).whiteboardElements;
    const [second] = validateCollaborationTeachingDocument(doc).projection.whiteboardElements;
    // An unchanged record is not parsed again: every projection shares its
    // element, so nothing may mutate it.
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.groupIds)).toBe(true);

    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    const whiteboard = teaching.get("whiteboardElements") as Y.Map<Y.Array<string>>;
    const impostor = new Y.Array<string>();
    impostor.insert(0, whiteboard.get("shape")!.toArray());
    whiteboard.set("impostor", impostor);

    expect(
      projectCollaborationTeachingDocument(doc).whiteboardElements.map(({ id }) => id),
    ).toEqual(["shape"]);
    expect(() => validateCollaborationTeachingDocument(doc)).toThrow(/mismatched identity/);
    doc.destroy();
  });

  it("counts reused whiteboard candidates in UTF-8 bytes against the scene limit", () => {
    // Three UTF-8 bytes per UTF-16 unit, so a string-length count would pass.
    const text = (id: string, index: number) => ({
      ...element(id, 1, `a${String(index).padStart(3, "0")}`),
      type: "text",
      fontSize: 20,
      fontFamily: 1,
      text: "မ".repeat(7_000),
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      originalText: "မ".repeat(7_000),
      autoResize: true,
      lineHeight: 1.25,
    });
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [],
      whiteboardElements: Array.from({ length: 70 }, (_, index) => text(`t${index}`, index)),
    });
    expect(validateCollaborationTeachingDocument(doc).projection.whiteboardElements).toHaveLength(
      70,
    );

    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    const whiteboard = teaching.get("whiteboardElements") as Y.Map<Y.Array<string>>;
    doc.transact(() => {
      for (let index = 70; index < 76; index += 1) {
        const record = new Y.Array<string>();
        record.insert(0, [
          JSON.stringify({
            kind: "element",
            version: 1,
            versionNonce: 10,
            element: text(`t${index}`, index),
          }),
        ]);
        whiteboard.set(`t${index}`, record);
      }
    });

    expect(() => projectCollaborationTeachingDocument(doc)).toThrow(/scene limit/);
    expect(() => validateCollaborationTeachingDocument(doc)).toThrow(/scene limit/);
    doc.destroy();
  });
});

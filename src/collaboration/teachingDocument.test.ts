import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { Slide } from "../types/slides";
import { MAX_YJS_UPDATE_BYTES } from "./protocol";
import { projectCollaborationDocument, seedCollaborationProject } from "./projectDocument";
import {
  assertCollaborationTeachingTransition,
  collaborationTransactionTouchesOnlyTeaching,
  collaborationTransactionTouchesTeaching,
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
  setCollaborationCurrentSlide,
  validateCollaborationTeachingDocument,
} from "./teachingDocument";
import { encodeCollaborationSlidePayload } from "./teachingSlides";
import { ASSET, element, slide } from "./teachingTestFixtures";
import {
  applyCollaborationWhiteboardDelta,
  MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES,
} from "./teachingWhiteboard";

describe("collaboration teaching document", () => {
  it("initializes an empty deck and scene without inventing a current slide", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [] });

    expect(validateCollaborationTeachingDocument(doc).projection).toMatchObject({
      initialized: true,
      slideOrder: [],
      currentSlideId: null,
      presentationRevision: 0,
      whiteboardElements: [],
    });
    doc.destroy();
  });

  it("seeds an immutable ordered manifest without putting slide content in Yjs", () => {
    const doc = new Y.Doc();
    const secret = "payload-only-secret";
    seedCollaborationTeachingDocument(doc, {
      slides: [
        { slide: slide("one", 0, secret), asset: ASSET },
        { slide: slide("two", 1), asset: { ...ASSET, id: "b".repeat(64) } },
      ],
      whiteboardElements: [element("shape")],
    });
    const projection = validateCollaborationTeachingDocument(doc).projection;
    expect(projection.slideOrder).toEqual(["one", "two"]);
    expect(projection.currentSlideId).toBe("one");
    expect(projection.whiteboardElements).toEqual([expect.objectContaining({ id: "shape" })]);
    expect(JSON.stringify(doc.toJSON())).not.toContain(secret);
    expect(() =>
      seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [] }),
    ).toThrow(/already initialized/);
    doc.destroy();
  });

  it("preserves the optional teaching root through schema-1 project projection and snapshots", () => {
    const doc = new Y.Doc();
    seedCollaborationProject(doc, {
      id: "project",
      name: "Project",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: [],
      files: {
        "index.html": {
          path: "index.html",
          name: "index.html",
          language: "html",
          content: "<main>Hello</main>",
        },
      },
    });
    seedCollaborationTeachingDocument(doc, {
      slides: [{ slide: slide("one", 0), asset: ASSET }],
      whiteboardElements: [element("shape")],
    });

    expect(projectCollaborationDocument(doc).project.files["index.html"]?.content).toBe(
      "<main>Hello</main>",
    );
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    expect(projectCollaborationTeachingDocument(restored)).toMatchObject({
      initialized: true,
      slideOrder: ["one"],
      currentSlideId: "one",
    });

    restored.destroy();
    doc.destroy();
  });

  it("distinguishes teaching transactions from ordinary workspace updates", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [{ slide: slide("one", 0), asset: ASSET }],
      whiteboardElements: [],
    });
    const observations: Array<{ touches: boolean; onlyTeaching: boolean }> = [];
    const observe = (transaction: Y.Transaction) => {
      observations.push({
        touches: collaborationTransactionTouchesTeaching(doc, transaction),
        onlyTeaching: collaborationTransactionTouchesOnlyTeaching(doc, transaction),
      });
    };
    doc.on("afterTransaction", observe);

    doc.getMap("project").set("metadata", new Y.Map());
    setCollaborationCurrentSlide(doc, "one");
    applyCollaborationWhiteboardDelta(doc, { upserts: [element("shape")] });
    doc.transact(() => {
      const metadata = doc.getMap("project").get("metadata") as Y.Map<unknown>;
      metadata.set("name", "updated");
      applyCollaborationWhiteboardDelta(doc, { upserts: [element("second-shape")] });
    });

    expect(observations).toEqual([
      { touches: false, onlyTeaching: false },
      { touches: true, onlyTeaching: true },
      { touches: true, onlyTeaching: false },
    ]);
    doc.off("afterTransaction", observe);
    doc.destroy();
  });

  it("recognizes a room-start initialization update as teaching-only", () => {
    const base = new Y.Doc();
    seedCollaborationProject(base, {
      id: "project",
      name: "Project",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: [],
      files: {
        "index.html": {
          path: "index.html",
          name: "index.html",
          language: "html",
          content: "<main>Hello</main>",
        },
      },
    });
    const candidate = new Y.Doc();
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(base));
    const stateVector = Y.encodeStateVector(candidate);
    seedCollaborationTeachingDocument(candidate, {
      slides: [{ slide: slide("one", 0), asset: ASSET }],
      whiteboardElements: [],
    });
    const target = new Y.Doc();
    Y.applyUpdate(target, Y.encodeStateAsUpdate(base));
    const observations: Array<{ touches: boolean; onlyTeaching: boolean }> = [];
    target.on("afterTransaction", (transaction) => {
      observations.push({
        touches: collaborationTransactionTouchesTeaching(target, transaction),
        onlyTeaching: collaborationTransactionTouchesOnlyTeaching(target, transaction),
      });
    });

    Y.applyUpdate(target, Y.encodeStateAsUpdate(candidate, stateVector));

    expect(observations).toEqual([{ touches: true, onlyTeaching: true }]);
    base.destroy();
    candidate.destroy();
    target.destroy();
  });

  it("rejects unsafe or malformed teaching payloads before projection", () => {
    expect(() =>
      encodeCollaborationSlidePayload({
        ...slide("bad-steps", 0),
        steps: [[{ elementId: "shape", durationMs: 10, delayMs: 0, tracks: [], extra: true }]],
      } as unknown as Slide),
    ).toThrow(/build-step/);

    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [] });
    expect(() =>
      applyCollaborationWhiteboardDelta(doc, {
        upserts: [
          {
            ...element("embedded-file"),
            type: "image",
          },
        ],
      }),
    ).toThrow(/malformed or unsafe/);
    expect(() =>
      applyCollaborationWhiteboardDelta(doc, {
        upserts: [{ ...element("embedded-frame"), type: "iframe" }],
      }),
    ).toThrow(/malformed or unsafe/);
    expect(() =>
      applyCollaborationWhiteboardDelta(doc, {
        upserts: [{ ...element("invalid-number"), x: Number.NaN }],
      }),
    ).toThrow(/malformed or unsafe/);
    expect(() =>
      applyCollaborationWhiteboardDelta(doc, {
        upserts: [
          {
            ...element("oversized"),
            customData: { payload: "x".repeat(MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES) },
          },
        ],
      }),
    ).toThrow(/too large/);
    const invalidAssetDoc = new Y.Doc();
    expect(() =>
      seedCollaborationTeachingDocument(invalidAssetDoc, {
        slides: [
          {
            slide: slide("oversized-asset", 0),
            asset: { ...ASSET, size: 5 * 1024 * 1024 + 1 },
          },
        ],
        whiteboardElements: [],
      }),
    ).toThrow(/too big/i);
    invalidAssetDoc.destroy();
    doc.destroy();
  });

  it("converges current slide and whiteboard element deltas", () => {
    const seed = new Y.Doc();
    seedCollaborationTeachingDocument(seed, {
      slides: [
        { slide: slide("one", 0), asset: ASSET },
        { slide: slide("two", 1), asset: { ...ASSET, id: "b".repeat(64) } },
      ],
      whiteboardElements: [],
    });
    const left = new Y.Doc();
    const right = new Y.Doc();
    const snapshot = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(left, snapshot);
    Y.applyUpdate(right, snapshot);
    expect(() => setCollaborationCurrentSlide(left, "missing")).toThrow(/not in the room/);
    const beforeSlideChange = Y.encodeStateVector(left);
    setCollaborationCurrentSlide(left, "two");
    expect(Y.encodeStateAsUpdate(left, beforeSlideChange).byteLength).toBeLessThan(
      MAX_YJS_UPDATE_BYTES,
    );
    applyCollaborationWhiteboardDelta(left, { upserts: [element("a", 1, "a0")] });
    applyCollaborationWhiteboardDelta(right, { upserts: [element("b", 1, "a1")] });
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    expect(projectCollaborationTeachingDocument(left).currentSlideId).toBe("two");
    expect(
      projectCollaborationTeachingDocument(left).whiteboardElements.map(({ id }) => id),
    ).toEqual(["a", "b"]);
    expect(projectCollaborationTeachingDocument(right)).toEqual(
      projectCollaborationTeachingDocument(left),
    );
    seed.destroy();
    left.destroy();
    right.destroy();
  });

  it("converges concurrent whole-slide navigation through Yjs ordering", () => {
    const seed = new Y.Doc();
    seedCollaborationTeachingDocument(seed, {
      slides: [
        { slide: slide("one", 0), asset: ASSET },
        { slide: slide("two", 1), asset: { ...ASSET, id: "b".repeat(64) } },
        { slide: slide("three", 2), asset: { ...ASSET, id: "c".repeat(64) } },
      ],
      whiteboardElements: [],
    });
    const left = new Y.Doc();
    const right = new Y.Doc();
    const snapshot = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(left, snapshot);
    Y.applyUpdate(right, snapshot);

    setCollaborationCurrentSlide(left, "two");
    setCollaborationCurrentSlide(right, "three");
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    const leftProjection = validateCollaborationTeachingDocument(left).projection;
    const rightProjection = validateCollaborationTeachingDocument(right).projection;
    expect(leftProjection).toEqual(rightProjection);
    expect(["two", "three"]).toContain(leftProjection.currentSlideId);
    expect(leftProjection.presentationRevision).toBe(1);

    seed.destroy();
    left.destroy();
    right.destroy();
  });

  it("fingerprints candidate history even when the projected whiteboard winner is unchanged", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [],
      whiteboardElements: [element("shape", 2)],
    });
    const before = validateCollaborationTeachingDocument(doc);
    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    const whiteboard = teaching.get("whiteboardElements") as Y.Map<Y.Array<string>>;
    const candidates = whiteboard.get("shape");
    candidates?.push([
      JSON.stringify({
        kind: "element",
        version: 1,
        versionNonce: 10,
        element: element("shape", 1),
      }),
    ]);
    const after = validateCollaborationTeachingDocument(doc);

    expect(after.projection.whiteboardElements).toEqual(before.projection.whiteboardElements);
    expect(after.mutableFingerprint).not.toBe(before.mutableFingerprint);
    doc.destroy();
  });

  it("rejects slide manifests that are not present in the immutable order", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [{ slide: slide("one", 0), asset: ASSET }],
      whiteboardElements: [],
    });
    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    const slides = teaching.get("slides") as Y.Map<Y.Map<unknown>>;
    const extra = new Y.Map<unknown>();
    extra.set("id", "orphan");
    extra.set("contentType", "html");
    extra.set("assetId", "b".repeat(64));
    extra.set("assetMimeType", ASSET.mimeType);
    extra.set("assetSize", ASSET.size);
    slides.set("orphan", extra);

    expect(() => validateCollaborationTeachingDocument(doc)).toThrow(/manifest is malformed/);
    doc.destroy();
  });

  it("rejects unknown teaching and presentation fields", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [] });
    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    teaching.set("buildStep", 4);
    expect(() => validateCollaborationTeachingDocument(doc)).toThrow(/unsupported field/);
    doc.destroy();
  });

  it("requires a current slide when the immutable deck is nonempty", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [{ slide: slide("one", 0), asset: ASSET }],
      whiteboardElements: [],
    });
    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    const presentation = teaching.get("presentation") as Y.Map<unknown>;
    presentation.set("currentSlideId", null);

    expect(() => validateCollaborationTeachingDocument(doc)).toThrow(/presentation state/);
    doc.destroy();
  });

  it("accepts mutable teaching changes while rejecting generic initialization and stale state", () => {
    const uninitialized = new Y.Doc();
    const initialized = new Y.Doc();
    seedCollaborationTeachingDocument(initialized, {
      slides: [
        { slide: slide("one", 0), asset: ASSET },
        { slide: slide("two", 1), asset: { ...ASSET, id: "b".repeat(64) } },
      ],
      whiteboardElements: [],
    });
    const emptyIntegrity = validateCollaborationTeachingDocument(uninitialized);
    expect(() =>
      assertCollaborationTeachingTransition(
        emptyIntegrity,
        validateCollaborationTeachingDocument(initialized),
      ),
    ).toThrow(/owner initialization/i);

    const before = validateCollaborationTeachingDocument(initialized);
    setCollaborationCurrentSlide(initialized, "two");
    const currentSlideChange = validateCollaborationTeachingDocument(initialized);
    expect(() => assertCollaborationTeachingTransition(before, currentSlideChange)).not.toThrow();

    const teaching = initialized.getMap("project").get("teaching") as Y.Map<unknown>;
    const presentation = teaching.get("presentation") as Y.Map<unknown>;
    presentation.set("currentSlideId", "one");
    expect(() =>
      assertCollaborationTeachingTransition(
        currentSlideChange,
        validateCollaborationTeachingDocument(initialized),
      ),
    ).toThrow(/advance the presentation revision/i);

    presentation.set("currentSlideId", "two");
    presentation.set("revision", 0);
    expect(() =>
      assertCollaborationTeachingTransition(
        currentSlideChange,
        validateCollaborationTeachingDocument(initialized),
      ),
    ).toThrow(/stale presentation revision/i);

    uninitialized.destroy();
    initialized.destroy();
  });

  it("rejects any post-initialization deck reorder", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [
        { slide: slide("one", 0), asset: ASSET },
        { slide: slide("two", 1), asset: { ...ASSET, id: "b".repeat(64) } },
      ],
      whiteboardElements: [],
    });
    const before = validateCollaborationTeachingDocument(doc);
    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    const order = teaching.get("slideOrder") as Y.Array<string>;
    order.delete(0, order.length);
    order.insert(0, ["two", "one"]);
    const after = validateCollaborationTeachingDocument(doc);

    expect(() => assertCollaborationTeachingTransition(before, after)).toThrow(
      /immutable room presentation/i,
    );
    doc.destroy();
  });

  it("rejects a present teaching root with the wrong Yjs type", () => {
    const doc = new Y.Doc();
    doc.getMap("project").set("teaching", "malformed");
    expect(() => validateCollaborationTeachingDocument(doc)).toThrow(/invalid structure/);
    doc.destroy();
  });
});

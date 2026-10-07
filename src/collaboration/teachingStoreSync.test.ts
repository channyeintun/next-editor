import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
  applyCollaborationWhiteboardDelta,
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
  setCollaborationCurrentSlide,
} from "./teachingDocument";
import { isSameTeachingProjection } from "./teachingStoreSync";

const ASSET = {
  id: "a".repeat(64),
  mimeType: "application/vnd.next-editor.slide+json",
  size: 100,
};

function element(id: string, version = 1, index = "a0") {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roundness: null,
    roughness: 1,
    opacity: 100,
    seed: 1,
    version,
    versionNonce: version * 10,
    index,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

describe("isSameTeachingProjection", () => {
  it("matches re-projections that change nothing shown, and nothing else", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, {
      slides: [
        {
          slide: { id: "one", order: 0, content: "<h1>one</h1>", contentType: "html" },
          asset: ASSET,
        },
        {
          slide: { id: "two", order: 1, content: "<h1>two</h1>", contentType: "html" },
          asset: { ...ASSET, id: "b".repeat(64) },
        },
      ],
      whiteboardElements: [element("shape", 2, "a0"), element("note", 1, "a1")],
    });
    const initial = projectCollaborationTeachingDocument(doc);
    expect(isSameTeachingProjection(initial, projectCollaborationTeachingDocument(doc))).toBe(true);

    // A peer's stale candidate joins the history, but the winner is unchanged.
    const teaching = doc.getMap("project").get("teaching") as Y.Map<unknown>;
    const whiteboard = teaching.get("whiteboardElements") as Y.Map<Y.Array<string>>;
    whiteboard.get("shape")?.push([
      JSON.stringify({
        kind: "element",
        version: 1,
        versionNonce: 10,
        element: element("shape"),
      }),
    ]);
    const afterStaleCandidate = projectCollaborationTeachingDocument(doc);
    expect(isSameTeachingProjection(initial, afterStaleCandidate)).toBe(true);

    applyCollaborationWhiteboardDelta(doc, { upserts: [element("note", 2, "a1")] });
    const afterStroke = projectCollaborationTeachingDocument(doc);
    expect(isSameTeachingProjection(afterStaleCandidate, afterStroke)).toBe(false);

    setCollaborationCurrentSlide(doc, "two");
    expect(isSameTeachingProjection(afterStroke, projectCollaborationTeachingDocument(doc))).toBe(
      false,
    );
    doc.destroy();
  });
});

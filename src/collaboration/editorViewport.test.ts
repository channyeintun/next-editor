import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getCollaborationTexts } from "./projectDocument";
import {
  createCollaborationEditorViewport,
  resolveCollaborationEditorViewport,
} from "./editorViewport";

const FILE_ID = "10000000-0000-4000-8000-000000000001";

function documentWithText(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = new Y.Text(content);
  getCollaborationTexts(doc).set(FILE_ID, text);
  return { doc, text };
}

describe("collaboration editor viewport", () => {
  it("keeps the logical top content anchored through edits above it", () => {
    const { doc, text } = documentWithText("first\nsecond\nthird");
    const offset = text.toString().indexOf("third");
    const viewport = createCollaborationEditorViewport(doc, FILE_ID, offset, 7, 320);
    expect(viewport).not.toBeNull();
    text.insert(0, "inserted\n");
    expect(resolveCollaborationEditorViewport(doc, FILE_ID, viewport!)).toEqual({
      topOffset: offset + "inserted\n".length,
      topDeltaPx: 7,
      scrollLeftPx: 320,
    });
    doc.destroy();
  });

  it("moves the anchor back when content above it is deleted", () => {
    const { doc, text } = documentWithText("remove me\nkeep me");
    const originalOffset = text.toString().indexOf("keep me");
    const viewport = createCollaborationEditorViewport(doc, FILE_ID, originalOffset, 0, 0);
    text.delete(0, "remove me\n".length);

    expect(resolveCollaborationEditorViewport(doc, FILE_ID, viewport!)).toMatchObject({
      topOffset: 0,
    });
    doc.destroy();
  });

  it("clamps offsets and viewport pixels", () => {
    const { doc } = documentWithText("abc");
    const viewport = createCollaborationEditorViewport(
      doc,
      FILE_ID,
      100,
      Number.POSITIVE_INFINITY,
      -50,
    );
    expect(viewport).toMatchObject({ topDeltaPx: 0, scrollLeftPx: 0 });
    expect(resolveCollaborationEditorViewport(doc, FILE_ID, viewport!)).toMatchObject({
      topOffset: 3,
    });
    const nonFiniteOffset = createCollaborationEditorViewport(doc, FILE_ID, Number.NaN, 0, 0);
    expect(resolveCollaborationEditorViewport(doc, FILE_ID, nonFiniteOffset!)).toMatchObject({
      topOffset: 0,
    });
    doc.destroy();
  });

  it("fails safely for a missing or mismatched shared text", () => {
    const { doc } = documentWithText("");
    const viewport = createCollaborationEditorViewport(doc, FILE_ID, 0, 0, 0);
    getCollaborationTexts(doc).delete(FILE_ID);
    expect(resolveCollaborationEditorViewport(doc, FILE_ID, viewport!)).toBeNull();
    expect(createCollaborationEditorViewport(doc, FILE_ID, 0, 0, 0)).toBeNull();
    doc.destroy();
  });

  it("supports an empty text file and rejects the same file ID in another document", () => {
    const source = documentWithText("");
    const viewport = createCollaborationEditorViewport(source.doc, FILE_ID, 0, 0, 0);
    expect(resolveCollaborationEditorViewport(source.doc, FILE_ID, viewport!)).toEqual({
      topOffset: 0,
      topDeltaPx: 0,
      scrollLeftPx: 0,
    });

    const unrelated = documentWithText("");
    expect(resolveCollaborationEditorViewport(unrelated.doc, FILE_ID, viewport!)).toBeNull();
    source.doc.destroy();
    unrelated.doc.destroy();
  });
});

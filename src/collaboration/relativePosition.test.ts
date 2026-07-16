import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  collaborationParticipantColorIndex,
  createCollaborationCursor,
  resolveCollaborationCursor,
} from "./relativePosition";
import { getCollaborationTexts } from "./projectDocument";

const FILE_ID = "10000000-0000-4000-8000-000000000001";

describe("collaboration relative positions", () => {
  it("keeps a cursor anchored across concurrent text insertion", () => {
    const doc = new Y.Doc();
    const text = new Y.Text("hello world");
    getCollaborationTexts(doc).set(FILE_ID, text);
    const cursor = createCollaborationCursor(doc, FILE_ID, 6, 11);
    expect(cursor).not.toBeNull();

    text.insert(0, "say ");
    expect(resolveCollaborationCursor(doc, cursor!)).toEqual({
      anchorOffset: 10,
      headOffset: 15,
    });
  });

  it("derives a stable participant color from actor and tab identity", () => {
    const participant = {
      actorId: "20000000-0000-4000-8000-000000000001",
      sessionId: "30000000-0000-4000-8000-000000000001",
    };
    expect(collaborationParticipantColorIndex(participant)).toBe(
      collaborationParticipantColorIndex(participant),
    );
    expect(collaborationParticipantColorIndex(participant)).toBeGreaterThanOrEqual(0);
    expect(collaborationParticipantColorIndex(participant)).toBeLessThan(8);
  });
});

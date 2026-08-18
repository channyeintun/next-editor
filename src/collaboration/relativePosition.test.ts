import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  collaborationParticipantColorIndex,
  createCollaborationCursor,
  resolveCollaborationCursor,
} from "./relativePosition";
import { getCollaborationTexts } from "./projectDocument";

const FILE_ID = "10000000-0000-4000-8000-000000000001";

/**
 * A relative position pointing at a *root* type by name — the only shape whose
 * resolution can create a root. This app never produces one (every text is
 * nested under "project"), so it stands in for a hostile peer's payload.
 */
function encodeRootRelativePosition(rootName: string): string {
  const scratch = new Y.Doc();
  const rootText = scratch.getText(rootName);
  rootText.insert(0, "x");
  const bytes = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(rootText, rootText.length),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

  // `Y.createAbsolutePositionFromRelativePosition` resolves a `tname` through
  // `doc.get(tname)`, and `Y.Doc.get` CREATES the named root when it is absent —
  // so a peer-supplied anchor naming arbitrary roots could grow `doc.share`
  // without bound, one permanent entry per resolve.
  it("refuses a peer anchor that names a root type instead of resolving it", () => {
    const doc = new Y.Doc();
    const text = new Y.Text("hello world");
    getCollaborationTexts(doc).set(FILE_ID, text);

    const rootsBefore = new Set(doc.share.keys());
    const hostileAnchor = encodeRootRelativePosition("attacker-controlled-root");

    expect(
      resolveCollaborationCursor(doc, {
        fileNodeId: FILE_ID,
        anchor: hostileAnchor,
        head: hostileAnchor,
      }),
    ).toBeNull();
    expect(new Set(doc.share.keys())).toEqual(rootsBefore);
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

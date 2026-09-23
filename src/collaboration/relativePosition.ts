import * as Y from "yjs";
import { getCollaborationTexts } from "./projectDocument";
import type { CollaborationAwarenessEvent, CollaborationCursor } from "./protocol";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { collaborationParticipantKey } from "./participantKey";

/**
 * False for the one relative-position shape that can mutate our document.
 *
 * `Y.createAbsolutePositionFromRelativePosition` resolves a `tname` through
 * `doc.get(tname)`, and `Y.Doc.get` *creates* the named root type when it is
 * absent. Positions come straight off the wire (awareness cursors, viewport
 * anchors, y-monaco selections), so a peer could name any root it liked and
 * permanently add it to `doc.share` on every resolve — unbounded, remotely
 * driven growth of the shared document.
 *
 * Nothing legitimate is lost by refusing it: every collaboration Y.Text is
 * nested under the "project" root, and yjs only fills `tname` for a *root* type
 * (`createRelativePositionFromTypeIndex` sets `typeid` instead whenever
 * `type._item !== null`). So a position from this app always has
 * `tname === null`.
 */
export function isSafeForeignRelativePosition(position: { tname?: unknown }): boolean {
  return position.tname == null;
}

/** Decodes a peer-supplied base64 relative position, or null when it is unsafe. */
export function decodeForeignRelativePosition(value: string): Y.RelativePosition | null {
  const relativePosition = Y.decodeRelativePosition(base64ToBytes(value));
  return isSafeForeignRelativePosition(relativePosition) ? relativePosition : null;
}

export function createCollaborationCursor(
  doc: Y.Doc,
  fileNodeId: string,
  anchorOffset: number,
  headOffset: number,
): CollaborationCursor | null {
  const text = getCollaborationTexts(doc).get(fileNodeId);
  if (!(text instanceof Y.Text)) return null;
  const clamp = (offset: number) => Math.max(0, Math.min(text.length, Math.trunc(offset)));
  return {
    fileNodeId,
    anchor: bytesToBase64(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, clamp(anchorOffset))),
    ),
    head: bytesToBase64(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, clamp(headOffset))),
    ),
  };
}

export function resolveCollaborationCursor(
  doc: Y.Doc,
  cursor: CollaborationCursor,
): { anchorOffset: number; headOffset: number } | null {
  try {
    const text = getCollaborationTexts(doc).get(cursor.fileNodeId);
    if (!(text instanceof Y.Text)) return null;
    const anchorPosition = decodeForeignRelativePosition(cursor.anchor);
    const headPosition = decodeForeignRelativePosition(cursor.head);
    if (!anchorPosition || !headPosition) return null;
    const anchor = Y.createAbsolutePositionFromRelativePosition(anchorPosition, doc);
    const head = Y.createAbsolutePositionFromRelativePosition(headPosition, doc);
    if (!anchor || !head || anchor.type !== text || head.type !== text) return null;
    return { anchorOffset: anchor.index, headOffset: head.index };
  } catch {
    return null;
  }
}

export function collaborationParticipantColorIndex(
  participant: Pick<CollaborationAwarenessEvent, "actorId" | "sessionId">,
  colorCount = 8,
): number {
  let hash = 2166136261;
  const identity = collaborationParticipantKey(participant);
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % colorCount;
}

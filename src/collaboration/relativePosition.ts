import * as Y from "yjs";
import { getCollaborationTexts } from "./projectDocument";
import type { CollaborationAwarenessEvent, CollaborationCursor } from "./protocol";

const BINARY_CHUNK_SIZE = 0x8000;

function encodeBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK_SIZE));
  }
  return btoa(binary);
}

function decodeBinary(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Decode a peer-supplied relative position, refusing the one shape that can
 * mutate our document.
 *
 * `Y.createAbsolutePositionFromRelativePosition` resolves a `tname` through
 * `doc.get(tname)`, and `Y.Doc.get` *creates* the named root type when it is
 * absent. The payload is base64 straight off the wire, so a peer could name any
 * root it liked and permanently add it to `doc.share` on every resolve —
 * unbounded, remotely driven growth of the shared document.
 *
 * Nothing legitimate is lost by refusing it: every collaboration Y.Text is
 * nested under the "project" root, and yjs only fills `tname` for a *root* type
 * (`createRelativePositionFromTypeIndex` sets `typeid` instead whenever
 * `type._item !== null`). So a cursor or viewport anchor from this app always
 * decodes with `tname === null`.
 */
export function decodeForeignRelativePosition(value: string): Y.RelativePosition | null {
  const relativePosition = Y.decodeRelativePosition(decodeBinary(value));
  return relativePosition.tname === null ? relativePosition : null;
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
    anchor: encodeBinary(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, clamp(anchorOffset))),
    ),
    head: encodeBinary(
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
  const identity = `${participant.actorId}:${participant.sessionId}`;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % colorCount;
}

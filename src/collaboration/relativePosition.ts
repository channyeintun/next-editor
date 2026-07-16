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
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeBinary(cursor.anchor)),
      doc,
    );
    const head = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeBinary(cursor.head)),
      doc,
    );
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

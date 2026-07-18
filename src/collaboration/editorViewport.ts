import * as Y from "yjs";
import {
  MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX,
  MAX_COLLABORATION_EDITOR_TOP_DELTA_PX,
  collaborationEditorViewportSchema,
  type CollaborationEditorViewport,
} from "./protocol";
import { getCollaborationTexts } from "./projectDocument";

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
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}

export function createCollaborationEditorViewport(
  doc: Y.Doc,
  fileNodeId: string,
  topOffset: number,
  topDeltaPx: number,
  scrollLeftPx: number,
): CollaborationEditorViewport | null {
  const text = getCollaborationTexts(doc).get(fileNodeId);
  if (!(text instanceof Y.Text)) return null;
  const offset = clampFinite(Math.trunc(topOffset), 0, text.length);
  const viewport = {
    topAnchor: encodeBinary(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset)),
    ),
    topDeltaPx: clampFinite(topDeltaPx, 0, MAX_COLLABORATION_EDITOR_TOP_DELTA_PX),
    scrollLeftPx: clampFinite(scrollLeftPx, 0, MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX),
  };
  const result = collaborationEditorViewportSchema.safeParse(viewport);
  return result.success ? result.data : null;
}

export function resolveCollaborationEditorViewport(
  doc: Y.Doc,
  fileNodeId: string,
  viewport: CollaborationEditorViewport,
): { topOffset: number; topDeltaPx: number; scrollLeftPx: number } | null {
  const parsed = collaborationEditorViewportSchema.safeParse(viewport);
  if (!parsed.success) return null;
  try {
    const text = getCollaborationTexts(doc).get(fileNodeId);
    if (!(text instanceof Y.Text)) return null;
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeBinary(parsed.data.topAnchor)),
      doc,
    );
    if (!absolute || absolute.type !== text) return null;
    return {
      topOffset: Math.max(0, Math.min(text.length, absolute.index)),
      topDeltaPx: parsed.data.topDeltaPx,
      scrollLeftPx: parsed.data.scrollLeftPx,
    };
  } catch {
    return null;
  }
}

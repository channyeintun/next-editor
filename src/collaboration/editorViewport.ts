import * as Y from "yjs";
import {
  MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX,
  MAX_COLLABORATION_EDITOR_TOP_DELTA_PX,
  collaborationEditorViewportSchema,
  type CollaborationEditorViewport,
} from "./protocol";
import { getCollaborationTexts } from "./projectDocument";
import { decodeForeignRelativePosition } from "./relativePosition";

const BINARY_CHUNK_SIZE = 0x8000;

function encodeBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK_SIZE));
  }
  return btoa(binary);
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
    const topPosition = decodeForeignRelativePosition(parsed.data.topAnchor);
    if (!topPosition) return null;
    const absolute = Y.createAbsolutePositionFromRelativePosition(topPosition, doc);
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

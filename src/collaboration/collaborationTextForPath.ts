import type * as Y from "yjs";
import { getCollaborationTexts } from "./projectDocument";

/**
 * The shared text of the room file at `path`: undefined when the room has no
 * file there, or when its project document cannot be read (yet).
 */
export function collaborationTextForPath(
  room: { getNodeIdForPath(path: string): string | null },
  doc: Y.Doc,
  path: string,
): Y.Text | undefined {
  try {
    const fileNodeId = room.getNodeIdForPath(path);
    return fileNodeId ? getCollaborationTexts(doc).get(fileNodeId) : undefined;
  } catch {
    return undefined;
  }
}

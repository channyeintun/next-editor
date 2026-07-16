import * as Y from "yjs";
import { COLLABORATION_ORIGIN, getCollaborationTexts } from "./projectDocument";

/**
 * Tracks only local editor transactions. Remote updates, workspace projection,
 * playback, and tree commands therefore never enter another participant's
 * undo history.
 */
export function createCollaborationUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(getCollaborationTexts(doc), {
    trackedOrigins: new Set([COLLABORATION_ORIGIN.localEditor]),
    captureTimeout: 500,
  });
}

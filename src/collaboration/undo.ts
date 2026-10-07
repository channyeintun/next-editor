import * as Y from "yjs";
import { COLLABORATION_ORIGIN, getCollaborationTexts } from "./projectDocument";

// Origins that modules this one must not import register themselves here.
// CodeEditor registers y-monaco's MonacoBinding: importing it here would make
// every chunk that reaches CollaborationContext (the /learn gallery, the lesson
// shell) statically import all of Monaco instead of only the lazy CodeEditor.
const registeredOrigins = new Set<unknown>();
const liveManagers = new Set<Y.UndoManager>();

class CollaborationUndoManager extends Y.UndoManager {
  // Y.UndoManager binds destroy() and registers it for the doc's own destroy,
  // so this runs on both teardown paths.
  destroy(): void {
    liveManagers.delete(this);
    super.destroy();
  }
}

/**
 * Tracks `origin` (a transaction origin, or a class whose instances are origins)
 * in every collaboration undo manager, including managers that already exist:
 * a room can sync before the module that registers an origin has loaded.
 */
export function trackCollaborationUndoOrigin(origin: unknown): void {
  registeredOrigins.add(origin);
  for (const manager of liveManagers) manager.addTrackedOrigin(origin);
}

/**
 * Tracks only local editor transactions. Remote updates, workspace projection,
 * playback, and tree commands therefore never enter another participant's
 * undo history.
 */
export function createCollaborationUndoManager(doc: Y.Doc): Y.UndoManager {
  const manager = new CollaborationUndoManager(getCollaborationTexts(doc), {
    trackedOrigins: new Set([COLLABORATION_ORIGIN.localEditor, ...registeredOrigins]),
    captureTimeout: 500,
  });
  liveManagers.add(manager);
  return manager;
}

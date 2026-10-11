import * as Y from "yjs";
import { COLLABORATION_ORIGIN, getCollaborationTexts } from "./projectDocument";
import { MAX_YJS_UPDATE_BYTES } from "./protocol";

// The most deleted text one undo step may restore. Undo re-inserts it in one
// update, which the room refuses above MAX_YJS_UPDATE_BYTES; the rest allows
// for that update's item and delete-set overhead.
const UNDO_RESTORE_BUDGET_BYTES = MAX_YJS_UPDATE_BYTES - 4 * 1024;
const textEncoder = new TextEncoder();

// Origins that modules this one must not import register themselves here.
// CodeEditor's y-monaco binding (components/codeEditor/useYMonacoBinding.ts)
// registers MonacoBinding: importing it here would make every chunk that
// reaches CollaborationContext (the /learn gallery, the lesson shell)
// statically import all of Monaco instead of only the lazy CodeEditor.
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
 * UTF-8 bytes of the text `transaction` deleted, which is what undoing it
 * re-inserts. Runs before the transaction's cleanup, so deleted items still
 * hold their content. Stops counting once past the budget.
 */
function deletedTextBytes(transaction: Y.Transaction): number {
  let bytes = 0;
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
    if (bytes > UNDO_RESTORE_BUDGET_BYTES) return;
    if (struct instanceof Y.Item && struct.content instanceof Y.ContentString) {
      bytes += textEncoder.encode(struct.content.str).byteLength;
    }
  });
  return bytes;
}

/**
 * Tracks only local editor transactions. Remote updates, workspace projection,
 * playback, and tree commands therefore never enter another participant's
 * undo history.
 *
 * A change whose undo (or redo) would restore more text than one room update
 * carries is not captured, so it cannot be undone in a live room. Undoing it
 * used to end the session; Ctrl+Z now skips it.
 */
export function createCollaborationUndoManager(doc: Y.Doc): Y.UndoManager {
  const manager = new CollaborationUndoManager(getCollaborationTexts(doc), {
    trackedOrigins: new Set([COLLABORATION_ORIGIN.localEditor, ...registeredOrigins]),
    captureTimeout: 500,
    captureTransaction: (transaction) => deletedTextBytes(transaction) <= UNDO_RESTORE_BUDGET_BYTES,
  });
  liveManagers.add(manager);
  return manager;
}

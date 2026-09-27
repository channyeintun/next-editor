import { useEffect } from "react";
import type { EditorActorRef } from "../core/src/useNextEditor";
import { journalRecordingTakes } from "../storage/recordingDrafts/journalRecordingTakes";

/**
 * Journals every take this editor records to IndexedDB as it goes (see
 * storage/recordingDrafts), so a crash, a reload or a closed tab leaves a draft
 * the recovery prompt can bring back. Off for surfaces whose takes are not the
 * author's to lose, such as studio renders.
 */
export function useRecordingDraftJournal(actorRef: EditorActorRef, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof indexedDB === "undefined") return;
    return journalRecordingTakes(actorRef);
  }, [actorRef, enabled]);
}

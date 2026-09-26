import { useEffect } from "react";
import type { EditorActorRef, EditorMachineSnapshot } from "../core/src/useNextEditor";
import type { RecordingSession } from "../core/src/machine/types";
import { getRecordingTimestamp } from "../core/src/machine/recordingSession";
import {
  linkRecordingToDraft,
  startRecordingDraftJournal,
  type RecordingDraftFlush,
  type RecordingDraftJournal,
} from "../storage/recordingDrafts/recordingDraftJournal";
import type { RecordingDraftMediaTrack } from "../storage/recordingDrafts/recordingDraftStore";

/** How much of a take a crash can cost at most, beyond the recorder's own one-second chunks. */
const FLUSH_INTERVAL_MS = 3_000;

interface JournaledTake {
  session: RecordingSession;
  journal: RecordingDraftJournal;
  clock: RecordingSession["clock"];
  timer: ReturnType<typeof setInterval>;
}

function describeTake(
  snapshot: EditorMachineSnapshot,
  session: RecordingSession,
): RecordingDraftFlush {
  const { audio, camera } = snapshot.context;
  return {
    durationMs: getRecordingTimestamp(session),
    audio:
      audio.source === "microphone" && audio.mimeType
        ? { mimeType: audio.mimeType, source: "microphone" }
        : audio.source === "external" && audio.blob
          ? { mimeType: audio.mimeType || audio.blob.type, source: "external" }
          : undefined,
    camera:
      camera.source === "camera" && camera.mimeType
        ? { mimeType: camera.mimeType, startOffsetMs: camera.startOffsetMs }
        : undefined,
    mediaCuts: [...session.mediaCuts],
    chapters: [...session.chapters],
    slides: snapshot.context.getSlides?.(),
  };
}

/**
 * Journals every take this editor records to IndexedDB as it goes (see
 * storage/recordingDrafts), so a crash, a reload or a closed tab leaves a draft
 * the recovery prompt can bring back. Off for surfaces whose takes are not the
 * author's to lose, such as studio renders.
 */
export function useRecordingDraftJournal(actorRef: EditorActorRef, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof indexedDB === "undefined") return;

    let take: JournaledTake | null = null;
    const attachedRecorders = new Map<MediaRecorder, () => void>();

    const flushTake = (overrides?: Partial<RecordingDraftFlush>) => {
      if (!take) return;
      void take.journal.flush({
        ...describeTake(actorRef.getSnapshot(), take.session),
        ...overrides,
      });
    };

    // The recorders hand their chunks to every listener, so the journal keeps its own
    // copy without touching the recorder actors. A chunk that lands after the take
    // was finalized (a slow stop) still belongs to it.
    const attachRecorder = (
      recorder: MediaRecorder | null,
      track: RecordingDraftMediaTrack,
      journal: RecordingDraftJournal,
    ) => {
      if (!recorder || attachedRecorders.has(recorder)) return;
      const onData = (event: BlobEvent) => {
        if (event.data.size > 0) journal.addMedia(track, event.data);
      };
      const detach = () => {
        recorder.removeEventListener("dataavailable", onData);
        recorder.removeEventListener("stop", onStop);
        attachedRecorders.delete(recorder);
      };
      const onStop = () => detach();
      recorder.addEventListener("dataavailable", onData);
      recorder.addEventListener("stop", onStop);
      attachedRecorders.set(recorder, detach);
    };

    const endTake = (snapshot: EditorMachineSnapshot) => {
      if (!take) return;
      clearInterval(take.timer);
      const recording = snapshot.context.recording;
      if (recording) linkRecordingToDraft(recording.id, take.journal.id);
      void take.journal.flush({
        ...describeTake(snapshot, take.session),
        durationMs: recording?.duration ?? getRecordingTimestamp(take.session),
        finished: true,
        recordingId: recording?.id,
      });
      take.journal.close();
      take = null;
    };

    const onSnapshot = (snapshot: EditorMachineSnapshot) => {
      const session = snapshot.context.session;

      if (session && take?.session !== session) {
        endTake(snapshot);
        const journal = startRecordingDraftJournal(session, session.startedAt);
        take = {
          session,
          journal,
          clock: session.clock,
          timer: setInterval(() => flushTake(), FLUSH_INTERVAL_MS),
        };
        // A selected narration file is the take's audio as it is.
        const { audio } = snapshot.context;
        if (audio.source === "external" && audio.blob) journal.addMedia("audio", audio.blob);
        flushTake();
      }

      if (take) {
        attachRecorder(snapshot.context.audio.mediaRecorder, "audio", take.journal);
        attachRecorder(snapshot.context.camera.mediaRecorder, "camera", take.journal);
        // A pause is a natural moment to be up to date.
        if (session && session.clock !== take.clock) {
          take.clock = session.clock;
          flushTake();
        }
      }

      if (take && !session) endTake(snapshot);
    };

    const subscription = actorRef.subscribe(onSnapshot);
    onSnapshot(actorRef.getSnapshot());

    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushTake();
    };
    const flushOnPageHide = () => flushTake();
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushOnPageHide);

    return () => {
      subscription.unsubscribe();
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushOnPageHide);
      if (take) {
        clearInterval(take.timer);
        flushTake();
      }
      // Each detach deletes its own entry, which a Map iteration tolerates.
      for (const detach of attachedRecorders.values()) detach();
    };
  }, [actorRef, enabled]);
}

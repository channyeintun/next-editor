import { assembleRecording, type RecordingTracks } from "../../core/src/machine/recordingAssembly";
import { resolveLatestRuntimeSnapshot } from "../../core/src/runtimeTrack";
import type { Recording } from "../../core/src/types";
import { toSidebarWidthDeltaSnapshot } from "../../types/workspace";
import { getRecordingDraftStore } from "./recordingDraftStore";
import { rebuildRecordingDraftTracks } from "./recordingDraftTracks";

const lastOf = <T>(entries: readonly T[], time: (entry: T) => number): number =>
  entries.length > 0 ? time(entries[entries.length - 1]) : 0;

/** The latest recorded time any track reached. */
function lastRecordedTime(tracks: RecordingTracks): number {
  const byTimestamp = (entry: { timestamp: number }) => entry.timestamp;
  const byTime = (entry: { time: number }) => entry.time;
  return Math.max(
    lastOf(tracks.frames, byTimestamp),
    lastOf(tracks.cursorEvents, byTimestamp),
    lastOf(tracks.slideEvents, byTimestamp),
    lastOf(tracks.previewEvents, byTimestamp),
    lastOf(tracks.previewInitialDocuments, byTime),
    lastOf(tracks.previewPatchBatches, byTime),
    lastOf(tracks.workspaceEvents, byTimestamp),
    lastOf(tracks.runtimeEvents, byTimestamp),
    lastOf(tracks.whiteboardEvents, byTimestamp),
    lastOf(tracks.chatEvents, byTimestamp),
  );
}

/**
 * Rebuilds the Recording a draft's take would have become, as of its last write.
 * Null when the draft is gone, or holds no frame (its tab closed within the first
 * write), so there is nothing to play.
 */
export async function recoverRecordingDraft(draftId: string): Promise<Recording | null> {
  const draft = await getRecordingDraftStore().readDraft(draftId);
  if (!draft) return null;

  const { tracks, slides } = rebuildRecordingDraftTracks(draft.records);
  if (tracks.frames.length === 0) return null;

  const { meta, media } = draft;
  const lastWorkspaceEvent = tracks.workspaceEvents[tracks.workspaceEvents.length - 1];
  const workspaceSnapshot = lastWorkspaceEvent
    ? (() => {
        // The take's final workspace is a state, not a move: drop the panel offsets.
        const { previewDockWidthDelta: _dock, ...snapshot } = lastWorkspaceEvent.snapshot;
        return toSidebarWidthDeltaSnapshot(snapshot, 0);
      })()
    : undefined;
  const audioBlob =
    meta.audio && media.audio.length > 0
      ? new Blob(media.audio, { type: meta.audio.mimeType })
      : undefined;
  const cameraBlob =
    meta.camera && media.camera.length > 0
      ? new Blob(media.camera, { type: meta.camera.mimeType })
      : undefined;

  const recording = assembleRecording({
    tracks,
    duration: Math.max(1, meta.durationMs, lastRecordedTime(tracks)),
    slides,
    workspaceSnapshot,
    runtimeSnapshot: resolveLatestRuntimeSnapshot(tracks.runtimeEvents) ?? undefined,
    audio: {
      blob: audioBlob,
      source: audioBlob ? meta.audio?.source : undefined,
      mimeType: meta.audio?.mimeType,
      startOffsetMs: 0,
    },
    camera: {
      blob: cameraBlob,
      source: cameraBlob ? "camera" : undefined,
      mimeType: meta.camera?.mimeType,
      startOffsetMs: meta.camera?.startOffsetMs ?? 0,
    },
    // The recorders' chunks still hold what the take's retakes discarded.
    mediaCuts: meta.mediaCuts ?? [],
  });
  // The take's own id, when it got as far as being finalized: the draft is found by it
  // again after an upload or export, even from another page load.
  return meta.recordingId ? { ...recording, id: meta.recordingId } : recording;
}

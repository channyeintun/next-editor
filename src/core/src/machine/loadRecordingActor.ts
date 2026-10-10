import { fromPromise } from "xstate";
import type { Recording } from "../types";
import { measureAudioDurationSeconds } from "../utils/audioDuration";
import { hasAudioEdit } from "../utils/audioEditSpec";
import { getPlaybackAudioState } from "./playbackActors";
import { normalizeTimelineDuration } from "./playbackValues";

// ============================================================================
// The `loading` state's invoked actor.
//
// Readies a recording for playback: applies the narration edit a retake or an
// edit left (pendingAudioEdit), then measures the narration so the timeline ends
// where it does. editorMachine.ts registers it as `loadRecording`; tests replace
// it through `editorMachine.provide`. The encoder behind an edit (audioEdit.ts,
// with its Ogg/Opus muxer and WAV encoder) is imported only when a take has an
// edit to apply, so loading an unedited recording never loads it.
// ============================================================================

export const loadRecordingActor = fromPromise<
  { recording: Recording; duration: number },
  { recording: Recording | null }
>(async ({ input }) => {
  // Thrown here, not in the invoke's `input`: xstate treats a throwing input as fatal to
  // the whole editor actor, while a rejection reaches `loading.onError`.
  let recording = input.recording;
  if (!recording) throw new Error("No recording found to load");

  // A retake left what it discarded in the narration file, and an edit asks for cuts
  // and mutes. Both are applied here, once the audio is in hand; a microphone blob
  // that has not arrived yet keeps the edit for when it does.
  let editedAudioDurationMs: number | undefined;
  if (hasAudioEdit(recording.pendingAudioEdit) && recording.audioBlob instanceof Blob) {
    try {
      const { editRecordedAudio } = await import("../utils/audioEdit");
      const { blob: audioBlob, durationMs } = await editRecordedAudio(
        recording.audioBlob,
        recording.pendingAudioEdit,
      );
      editedAudioDurationMs = durationMs;
      recording = {
        ...recording,
        audioBlob,
        pendingAudioEdit: undefined,
        tracks: recording.tracks?.map((track) =>
          track.kind === "audio" ? { ...track, mimeType: audioBlob.type } : track,
        ),
      };
    } catch (err) {
      // Keeping the unedited narration is the lesser harm: it still plays, and its
      // stretches before the first cut stay in step.
      console.error("Failed to edit the recording's narration:", err);
      recording = { ...recording, pendingAudioEdit: undefined };
    }
  }

  let duration = normalizeTimelineDuration(recording.duration);

  const playbackAudioState = getPlaybackAudioState(recording);
  if (playbackAudioState?.finalized && recording.audioSource !== "external") {
    try {
      // An edit above already knows its output's length from the samples it
      // encoded, so only an unedited file is decoded to measure it.
      const exactDurationMs =
        editedAudioDurationMs ??
        (await measureAudioDurationSeconds(playbackAudioState.blob)) * 1000;
      // Use audio duration as the source of truth if it exists
      // This prevents trailing silence from wall-clock overhead
      duration = normalizeTimelineDuration(exactDurationMs, duration);
    } catch (err) {
      console.error("Failed to calculate exact audio duration:", err);
    }
  }

  return { recording: { ...recording, duration }, duration };
});

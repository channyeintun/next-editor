import type { Recording } from "../types";
import type { EditorMachineContext } from "./types";
import type { AudioPlaybackEvent, AudioPlaybackInput } from "./audioActor";

// ============================================================================
// Playback audio
//
// Drives the playback "audioPlayer" child: whether a recording has narration to
// play (getPlaybackAudioState), and the one spawn/seek/rate/volume/play sequence
// the machine's playback actions send it (syncPlaybackAudio).
// ============================================================================

interface PlaybackAudioState {
  /**
   * Raw audio blob from MediaRecorder. Used for immediate playback after
   * recording while the lesson is unpublished and has no audioUrl yet.
   */
  blob: Blob;
  /**
   * Permanent CDN/storage URL, present only after the lesson is published.
   * Takes precedence over blob when available.
   */
  audioUrl?: string;
  startOffsetMs: number;
  finalized: boolean;
}

export const getPlaybackAudioState = (recording: Recording | null): PlaybackAudioState | null => {
  if (!recording) {
    return null;
  }

  const audioBlob = recording.audioBlob;
  if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
    return null;
  }

  const audioUrl = recording.audioUrl;

  const startOffsetMs = recording.audioStartOffsetMs ?? 0;

  return {
    blob: audioBlob,
    audioUrl,
    startOffsetMs,
    finalized: recording.streamFinalized ?? true,
  };
};

/**
 * The subset of xstate's `enqueue` object used to drive the "audioPlayer" child actor.
 * Kept structural (rather than importing xstate's generic `ActionEnqueuer`) so this
 * helper doesn't need to thread the machine's full setup() type parameters.
 */
interface PlaybackAudioEnqueue {
  spawnChild: (
    src: "audioPlayback",
    options: { id: "audioPlayer"; input: AudioPlaybackInput },
  ) => void;
  sendTo: (actor: "audioPlayer", event: AudioPlaybackEvent) => void;
  assign: (updater: Partial<EditorMachineContext>) => void;
}

interface SyncPlaybackAudioOptions {
  /** Spawn a fresh "audioPlayer" child if this recording has audio and none exists yet. */
  spawnIfMissing: boolean;
  /** Send SEEK to the current timeline position. */
  seek: boolean;
  /** Send SET_PLAYBACK_RATE to match the timeline speed. */
  syncRate: boolean;
  /** Send SET_VOLUME to match the timeline volume. */
  syncVolume: boolean;
  /** Send PLAY. */
  play: boolean;
}

/**
 * The one true spawn/append/seek/rate/volume/play sequence for the playback "audioPlayer"
 * child actor, encoding what used to be duplicated (with drifting variations) across
 * playback entry, EXTEND_RECORDING, and the "playing" entry in editorMachine.ts.
 *
 * Returns whether the audio actor is spawned and being controlled by this call, so
 * callers that need to interleave other actor messages (e.g. the timelineActor) around
 * the audio sequence can reuse that without recomputing it.
 */
export const syncPlaybackAudio = (
  context: EditorMachineContext,
  enqueue: PlaybackAudioEnqueue,
  options: SyncPlaybackAudioOptions,
): boolean => {
  const audioState = getPlaybackAudioState(context.recording);
  if (!audioState) {
    return false;
  }

  const spawning = options.spawnIfMissing && !context.playbackAudioSpawned;
  const controlling = spawning || context.playbackAudioSpawned;
  if (!controlling) {
    return false;
  }

  if (spawning) {
    enqueue.spawnChild("audioPlayback", {
      id: "audioPlayer",
      input: {
        blob: audioState.blob,
        audioUrl: audioState.audioUrl,
        startOffsetMs: audioState.startOffsetMs,
        volume: context.timeline.volume,
        playbackRate: context.timeline.speed,
        startPositionMs: context.timeline.currentTime,
      },
    });
    enqueue.assign({ playbackAudioSpawned: true });
  }

  if (options.seek) {
    enqueue.sendTo("audioPlayer", { type: "SEEK", timeMs: context.timeline.currentTime });
  }
  if (options.syncRate) {
    enqueue.sendTo("audioPlayer", { type: "SET_PLAYBACK_RATE", rate: context.timeline.speed });
  }
  if (options.syncVolume) {
    enqueue.sendTo("audioPlayer", { type: "SET_VOLUME", volume: context.timeline.volume });
  }
  if (options.play) {
    enqueue.sendTo("audioPlayer", { type: "PLAY" });
  }

  return true;
};

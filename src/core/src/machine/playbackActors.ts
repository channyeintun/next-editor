import type { Recording } from "../types";
import type { EditorActionArgs, EditorMachineContext } from "./types";
import type { AudioPlaybackEvent, AudioPlaybackInput } from "./audioActor";
import type { TimelineEvent } from "./timelineMachine";

// ============================================================================
// Playback actors
//
// What the machine sends its two playback children, the "timelineActor" clock
// and the "audioPlayer" narration player: whether a recording has narration to
// play (getPlaybackAudioState), the one spawn/seek/rate/volume/play sequence for
// the player (syncPlaybackAudio), and the action bodies that seek, start, pause
// and re-rate both. editorMachine.ts wraps each body as `enqueueActions(fn)`
// under the same name, so `setup()` still infers the machine's exact types.
// syncStreamedRecordingGrowth stays there: it reads the machine's state.
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

/**
 * How often, at most, a playing replay sends the narration player its SYNC safety net
 * (see audioPlaybackActor). Seeks, plays and speed changes reposition it at once.
 */
const PLAYBACK_AUDIO_SYNC_INTERVAL_MS = 250;

/**
 * The subset of xstate's `enqueue` object the playback actor sends use: the audio
 * helper's, plus messages to the "timelineActor" clock. Structural for the same reason
 * as PlaybackAudioEnqueue.
 */
interface PlaybackActorsEnqueue extends PlaybackAudioEnqueue {
  sendTo: PlaybackAudioEnqueue["sendTo"] & ((actor: "timelineActor", event: TimelineEvent) => void);
}

type PlaybackActorsArgs = EditorActionArgs & { enqueue: PlaybackActorsEnqueue };

/**
 * Moves the timeline and the narration to the playhead that seekToTime or resetPlayback
 * just stored, so both follow the one clamped value instead of re-deriving it.
 */
export const seekPlaybackActors = ({ context, enqueue }: PlaybackActorsArgs): void => {
  enqueue.sendTo("timelineActor", { type: "SEEK", time: context.timeline.currentTime });
  if (context.playbackAudioSpawned) {
    enqueue.sendTo("audioPlayer", { type: "SEEK", timeMs: context.timeline.currentTime });
  }
};

/**
 * A loaded recording's narration gets its player as playback begins; one that arrives
 * later (streaming) is spawned by syncStreamedRecordingGrowth or startPlaybackActors.
 */
export const spawnPlaybackAudio = ({ context, enqueue }: PlaybackActorsArgs): void => {
  syncPlaybackAudio(context, enqueue, {
    spawnIfMissing: true,
    seek: false,
    syncRate: false,
    syncVolume: false,
    play: false,
  });
};

/**
 * The timeline is the master clock: the narration follows it through the actor's SYNC
 * safety net, at most every PLAYBACK_AUDIO_SYNC_INTERVAL_MS.
 */
export const syncPlaybackAudioToTimeline = ({ context, enqueue }: PlaybackActorsArgs): void => {
  const lastSync = context.lastSyncTime || 0;
  const now = performance.now();
  if (context.playbackAudioSpawned && now - lastSync > PLAYBACK_AUDIO_SYNC_INTERVAL_MS) {
    enqueue.sendTo("audioPlayer", {
      type: "SYNC",
      timeMs: context.timeline.currentTime,
    });
    enqueue.assign({ lastSyncTime: now });
  }
};

/**
 * Hands the speed setPlaybackSpeed just stored to the timeline and, once spawned, the
 * narration.
 */
export const syncPlaybackActorsSpeed = ({ context, enqueue }: PlaybackActorsArgs): void => {
  const speed = context.timeline.speed;
  enqueue.sendTo("timelineActor", { type: "SET_SPEED", speed });
  if (context.playbackAudioSpawned) {
    enqueue.sendTo("audioPlayer", {
      type: "SET_PLAYBACK_RATE",
      rate: speed,
    });
  }
};

/** Hands the volume setVolume just stored to the narration, once spawned. */
export const syncPlaybackAudioVolume = ({ context, enqueue }: PlaybackActorsArgs): void => {
  if (context.playbackAudioSpawned) {
    enqueue.sendTo("audioPlayer", {
      type: "SET_VOLUME",
      volume: context.timeline.volume,
    });
  }
};

export const startPlaybackActors = ({ context, enqueue }: PlaybackActorsArgs): void => {
  // Ensure actors are positioned before starting playback. Starting
  // audio first can briefly play stale audio at high speeds, so PLAY
  // is sent after timelineActor START rather than through `play` here.
  //
  // Streaming playback: the audio may have arrived after the recording was first
  // loaded (its bytes are at the end of the stream), so the playback-entry spawn
  // saw no audio. Spawn the player lazily now that audio is available.
  const controllingPlaybackAudio = syncPlaybackAudio(context, enqueue, {
    spawnIfMissing: true,
    seek: true,
    syncRate: true,
    syncVolume: false,
    play: false,
  });

  enqueue.sendTo("timelineActor", {
    type: "SEEK",
    time: context.timeline.currentTime,
  });
  enqueue.sendTo("timelineActor", { type: "START" });
  if (controllingPlaybackAudio) {
    enqueue.sendTo("audioPlayer", { type: "PLAY" });
  }
};

export const pausePlaybackActors = ({ context, enqueue }: PlaybackActorsArgs): void => {
  enqueue.sendTo("timelineActor", { type: "PAUSE" });
  if (context.playbackAudioSpawned) {
    enqueue.sendTo("audioPlayer", { type: "PAUSE" });
  }
};

import type { RecordingAudioSource } from "../types";
import type {
  EditorActionArgs,
  EditorContextUpdate,
  EditorMachineContext,
  EditorMachineEvent,
} from "./types";
import type { AudioPlaybackEvent, AudioPlaybackInput, AudioRecordingInput } from "./audioActor";
import type { RecorderControlEvent } from "./recorderControl";

// ============================================================================
// Narration capture action bodies
//
// The take's audio slice: the microphone recorder ("audioRecorder") and a selected
// narration file, played in step with the take by "recordingAudioPlayer". What the
// slice holds (AudioState), starting each source, storing what its recorder sends,
// and dropping the slice when a take fails. editorMachine.ts wraps each body as
// `assign(fn)` / `enqueueActions(fn)` under the same name, so `setup()` still infers
// the machine's exact types. Imports from ./types are type-only: types.ts takes the
// slice and its idle factory from here.
// ============================================================================

/**
 * Audio state for recording and playback
 */
export interface AudioState {
  /** Audio blob from recording */
  blob: Blob | null;
  /** Whether audio recording is active */
  isRecording: boolean;
  /** MediaRecorder instance */
  mediaRecorder: MediaRecorder | null;
  /** Detected MIME type */
  mimeType: string;
  /** Source used for the active or finalized recording audio */
  source: RecordingAudioSource | null;
  /** Offset between the recording origin and the first audio sample on the editor timeline. */
  startOffsetMs: number;
  /** Known duration for external audio, in milliseconds */
  externalDurationMs: number | null;
}

/** The idle audio slice. A factory, so no two contexts or takes alias one slice. */
export const createIdleAudioState = (): AudioState => ({
  blob: null,
  isRecording: false,
  mediaRecorder: null,
  mimeType: "",
  source: null,
  startOffsetMs: 0,
  externalDurationMs: null,
});

/**
 * A selected narration file rides in on START_RECORDING. An empty file counts as none, so
 * that take records from the microphone (or silently) like a start without one.
 */
export const getExternalAudioBlob = (event: EditorMachineEvent): Blob | null =>
  event.type === "START_RECORDING" && event.audioBlob instanceof Blob && event.audioBlob.size > 0
    ? event.audioBlob
    : null;

/** The take's microphone, per take like the camera: a start that names none uses the default. */
export const setMicrophoneDevice = ({ event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "START_RECORDING") return {};
  return { microphoneDeviceId: event.microphoneDeviceId ?? null };
};

/**
 * The subset of xstate's `enqueue` object the microphone recorder's start uses. Kept
 * structural, like RecordingAudioPlayerEnqueue, so this body doesn't need to thread the
 * machine's full setup() type parameters.
 */
interface MicrophoneRecorderEnqueue {
  stopChild: (actor: "audioRecorder") => void;
  spawnChild: (
    src: "audioRecording",
    options: { id: "audioRecorder"; input: AudioRecordingInput },
  ) => void;
  sendTo: (actor: "audioRecorder", event: RecorderControlEvent) => void;
  assign: (updater: Partial<EditorMachineContext>) => void;
}

export const startMicrophoneRecorder = ({
  context,
  enqueue,
}: EditorActionArgs & { enqueue: MicrophoneRecorderEnqueue }): void => {
  // A previous take's recorder can outlive its session while it waits on a
  // late blob. Spawning under the same id would only replace the reference
  // and leave the old actor running, so stop it first.
  enqueue.stopChild("audioRecorder");
  // Spawn, not invoke: must survive into recording/stoppingRecording — its
  // AUDIO_RECORDING_STOPPED event arrives after leaving this state.
  enqueue.spawnChild("audioRecording", {
    id: "audioRecorder",
    input: { deviceId: context.microphoneDeviceId ?? undefined },
  });
  enqueue.sendTo("audioRecorder", { type: "START" });
  enqueue.assign({
    audio: { ...createIdleAudioState(), isRecording: true, source: "microphone" as const },
  });
};

export const prepareExternalAudioRecording = ({
  context,
  event,
}: EditorActionArgs): EditorContextUpdate => {
  const audioBlob = getExternalAudioBlob(event);
  if (!audioBlob) return {};

  return {
    audio: {
      ...context.audio,
      blob: audioBlob,
      isRecording: true,
      mediaRecorder: null,
      mimeType: audioBlob.type || "audio/webm",
      source: "external" as const,
      externalDurationMs: null,
    },
  };
};

interface RecordingAudioPlayerEnqueue {
  spawnChild: (
    src: "audioPlayback",
    options: { id: "recordingAudioPlayer"; input: AudioPlaybackInput },
  ) => void;
  sendTo: (actor: "recordingAudioPlayer", event: AudioPlaybackEvent) => void;
}

export const startExternalAudioPlayback = ({
  context,
  event,
  enqueue,
}: EditorActionArgs & { enqueue: RecordingAudioPlayerEnqueue }): void => {
  const audioBlob = getExternalAudioBlob(event);
  if (!audioBlob) return;

  enqueue.spawnChild("audioPlayback", {
    id: "recordingAudioPlayer",
    input: {
      blob: audioBlob,
      volume: context.timeline.volume,
      playbackRate: 1,
      startPositionMs: 0,
    },
  });
  enqueue.sendTo("recordingAudioPlayer", { type: "PLAY" });
};

export const storeExternalAudioDuration = ({
  context,
  event,
}: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "AUDIO_PLAYBACK_READY" || context.audio.source !== "external") {
    return {};
  }

  // A zero or unknown length says nothing about the narration. Storing it would let it
  // overwrite a real length reported earlier, and finalize would measure the take by it.
  const externalDurationMs =
    Number.isFinite(event.durationMs) && event.durationMs > 0 ? event.durationMs : null;
  if (externalDurationMs === null) return {};

  return {
    audio: {
      ...context.audio,
      externalDurationMs,
    },
  };
};

export const stopExternalAudioRecording = ({ context }: EditorActionArgs): EditorContextUpdate => {
  if (context.audio.source !== "external") return {};
  return {
    audio: {
      ...context.audio,
      isRecording: false,
    },
  };
};

export const resetAudioAfterRecorderStop = ({
  context,
}: EditorActionArgs): EditorContextUpdate => ({
  audio: {
    ...context.audio,
    isRecording: false,
    mediaRecorder: null,
    source: null,
    startOffsetMs: 0,
  },
});

export const storeAudioStarted = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "AUDIO_RECORDING_STARTED") return {};
  return {
    audio: {
      ...context.audio,
      mediaRecorder: event.mediaRecorder,
      mimeType: event.mimeType,
      startOffsetMs: 0,
    },
  };
};

export const storeAudioBlob = ({ event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "AUDIO_RECORDING_STOPPED") return {};
  return {
    audio: {
      ...createIdleAudioState(),
      blob: event.blob,
      mimeType: event.blob.type,
      source: "microphone" as const,
    },
  };
};

/**
 * Accept a microphone blob that arrives after the session has already finalized.
 *
 * `stoppingRecording` gives `MediaRecorder.stop()` 2s before a watchdog finalizes
 * anyway; a slower stop then delivers `AUDIO_RECORDING_STOPPED` in `loading` or
 * `playback`, where the capture-side handlers no longer exist. The blob is the
 * entire narration, so dropping it produced a silently silent lesson — the track
 * metadata still advertised audio (the microphone recorder was running at finalize)
 * while `Recording.audioBlob` was undefined, so playback and export found none.
 *
 * Splice it into the finalized recording instead. An already-attached blob wins:
 * the normal path has run and this is a duplicate.
 */
export const attachLateAudioBlob = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "AUDIO_RECORDING_STOPPED") return {};

  const audio = {
    ...context.audio,
    blob: event.blob,
    isRecording: false,
    mediaRecorder: null,
    mimeType: event.blob.type,
    source: "microphone" as const,
  };

  if (!context.recording || context.recording.audioBlob) {
    return { audio };
  }

  return {
    audio,
    recording: {
      ...context.recording,
      audioBlob: event.blob,
      audioSource: "microphone" as const,
      audioStartOffsetMs: context.recording.audioStartOffsetMs ?? 0,
    },
  };
};

export const handleAudioRecordingError = ({ event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "AUDIO_RECORDING_ERROR") return {};
  return { error: event.error };
};

/**
 * The selected narration file failed to play. The take cannot go on without it, so it
 * ends here: its audio slice and session are dropped and the failure is kept.
 */
export const handleExternalAudioError = ({ event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "AUDIO_PLAYBACK_ERROR") return {};
  return {
    error: event.error,
    audio: createIdleAudioState(),
    session: null,
  };
};

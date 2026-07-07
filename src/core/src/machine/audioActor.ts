import { fromCallback } from "xstate";

const AUDIO_SYNC_DRIFT_THRESHOLD_MS = 500;

/**
 * MediaRecorder timeslice (ms). Emitting `ondataavailable` on an interval produces
 * live audio chunks (forwarded as `CHUNK`) for incremental persistence / streaming,
 * while the final assembled blob is still emitted on stop exactly as before.
 */
const AUDIO_TIMESLICE_MS = 1000;

// ============================================================================
// Audio Actor Types
// ============================================================================

export interface AudioRecordingInput {
  /** Audio constraints */
  constraints?: MediaTrackConstraints;
}

export interface AudioPlaybackInput {
  /** Audio blob to play or the current contiguous stream snapshot */
  blob: Blob;
  /** Audio URL if external/imported */
  audioUrl?: string;
  /** Initial volume (0-1) */
  volume: number;
  /** Initial playback rate */
  playbackRate: number;
  /** Starting position in milliseconds */
  startPositionMs: number;
  /** Playback mode. Blob mode is the legacy/full-file path; stream mode updates the blob over time. */
  mode?: "blob" | "stream";
  /** Stream mode: end of the currently appended audio region on the editor timeline. */
  loadedUntilMs?: number;
  /** Stream mode: offset between the editor timeline origin and audio time 0. */
  startOffsetMs?: number;
  /** Stream mode: whether no more audio bytes will arrive. */
  finalized?: boolean;
}

export type AudioRecordingEvent = { type: "START" } | { type: "STOP" };

export type AudioPlaybackEvent =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; timeMs: number }
  | { type: "SET_VOLUME"; volume: number }
  | { type: "SET_PLAYBACK_RATE"; rate: number }
  | { type: "SYNC"; timeMs: number }
  | { type: "APPEND_FRAGMENT"; blob: Blob; loadedUntilMs: number; finalized?: boolean }
  | { type: "FINALIZE_STREAM" };

export type AudioRecordingEmit =
  | {
      type: "STARTED";
      mediaRecorder: MediaRecorder;
      mimeType: string;
      startedAtMs: number;
      startedAtPerf: number;
    }
  | { type: "CHUNK"; chunk: Blob; startTimeMs: number; endTimeMs: number }
  | { type: "STOPPED"; blob: Blob }
  | { type: "ERROR"; error: string };

export type AudioPlaybackEmit =
  | { type: "READY"; duration: number }
  | { type: "FINISHED" }
  | { type: "ERROR"; error: string };

// ============================================================================
// Audio Recording Actor
// ============================================================================

/**
 * Get the best supported audio MIME type
 */
const getSupportedAudioMimeType = (): string => {
  const mimeTypes = [
    "audio/webm; codecs=opus",
    "audio/webm",
    "audio/mp4; codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg; codecs=opus",
    "audio/ogg",
    "audio/wav",
    "audio/mpeg",
  ];

  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  for (const mimeType of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return "";
};

/**
 * Audio recording actor - manages MediaRecorder lifecycle
 */
export const audioRecordingActor = fromCallback<
  AudioRecordingEvent,
  AudioRecordingInput,
  AudioRecordingEmit
>(({ sendBack, receive, input }) => {
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let mimeType = "";
  let disposed = false;
  let starting = false;
  let startedAtMs = 0;
  let startedAtPerfMs = 0;
  let nextChunkStartTimeMs = 0;

  const cleanupStream = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  };

  const startRecording = async () => {
    if (starting || mediaRecorder) {
      return;
    }

    starting = true;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: input.constraints ?? {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      });

      if (disposed) {
        cleanupStream();
        return;
      }

      mimeType = getSupportedAudioMimeType();
      if (!mimeType) {
        cleanupStream();
        if (!disposed) {
          sendBack({ type: "ERROR", error: "No supported audio MIME type found" });
        }
        return;
      }

      mediaRecorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 32000,
        mimeType,
      });

      chunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          const endTimeMs =
            startedAtPerfMs > 0
              ? Math.max(nextChunkStartTimeMs, performance.now() - startedAtPerfMs)
              : nextChunkStartTimeMs;
          chunks.push(event.data);
          sendBack({
            type: "CHUNK",
            chunk: event.data,
            startTimeMs: nextChunkStartTimeMs,
            endTimeMs,
          });
          nextChunkStartTimeMs = endTimeMs;
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        if (!disposed) {
          sendBack({ type: "STOPPED", blob });
        }

        cleanupStream();
      };

      mediaRecorder.onstart = () => {
        if (!disposed && mediaRecorder) {
          startedAtMs = Date.now();
          startedAtPerfMs = performance.now();
          nextChunkStartTimeMs = 0;
          sendBack({
            type: "STARTED",
            mediaRecorder,
            mimeType,
            startedAtMs,
            startedAtPerf: startedAtPerfMs,
          });
        }
      };

      // Timeslice so audio data is delivered incrementally as `CHUNK` events; the
      // final blob is still assembled from the same chunks on stop.
      mediaRecorder.start(AUDIO_TIMESLICE_MS);
    } catch (error) {
      cleanupStream();
      if (!disposed) {
        sendBack({
          type: "ERROR",
          error: error instanceof Error ? error.message : "Failed to start recording",
        });
      }
    } finally {
      starting = false;
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  };

  receive((event) => {
    switch (event.type) {
      case "START":
        startRecording();
        break;
      case "STOP":
        stopRecording();
        break;
    }
  });

  return () => {
    disposed = true;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    cleanupStream();
  };
});

// ============================================================================
// Audio Playback Actor
// ============================================================================

/**
 * Audio playback actor — plays recording audio through a native HTMLAudioElement, synchronized to the
 * editor timeline. By bypassing Web Audio API decoding, startup is instant.
 * Pitch preservation is disabled so that changing the playback rate resamples the audio smoothly
 * without algorithmic artifacts (at the cost of raising/lowering the pitch).
 */
export const audioPlaybackActor = fromCallback<
  AudioPlaybackEvent,
  AudioPlaybackInput,
  AudioPlaybackEmit
>(({ sendBack, receive, input }) => {
  let disposed = false;
  let targetTimeMs = input.startPositionMs;
  let startOffsetMs = input.startOffsetMs ?? 0;
  let requestedPlay = false;

  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preservesPitch = true; // User requested pitch shift instead of native time-stretching

  let currentObjectUrl: string | null = null;
  if (input.audioUrl) {
    audio.src = input.audioUrl;
  } else {
    currentObjectUrl = URL.createObjectURL(input.blob);
    audio.src = currentObjectUrl;
  }

  audio.volume = input.volume;
  audio.playbackRate = input.playbackRate;

  const applyTargetTime = () => {
    const targetSec = Math.max(0, targetTimeMs - startOffsetMs) / 1000;
    if (Math.abs(audio.currentTime - targetSec) > AUDIO_SYNC_DRIFT_THRESHOLD_MS / 1000) {
      audio.currentTime = targetSec;
    }
  };

  // Seek immediately on spawn if needed
  applyTargetTime();

  audio.oncanplay = () => {
    if (disposed) return;
    // Duration might be Infinity for streaming blobs initially, so we just use the loadedUntilMs or fallback to 0
    const durationMs =
      Number.isFinite(audio.duration) && !isNaN(audio.duration)
        ? audio.duration * 1000
        : (input.loadedUntilMs ?? 0);
    sendBack({ type: "READY", duration: durationMs });
  };

  audio.onended = () => {
    if (disposed) return;
    sendBack({ type: "FINISHED" });
  };

  audio.onerror = () => {
    if (disposed) return;
    sendBack({ type: "ERROR", error: "Audio playback error" });
  };

  receive((event) => {
    if (disposed) return;

    switch (event.type) {
      case "PLAY":
        requestedPlay = true;
        applyTargetTime();
        audio.play().catch(() => {});
        break;
      case "PAUSE":
        requestedPlay = false;
        audio.pause();
        break;
      case "SEEK":
        targetTimeMs = event.timeMs;
        applyTargetTime();
        break;
      case "SYNC":
        targetTimeMs = event.timeMs;
        applyTargetTime();
        if (requestedPlay && audio.paused) {
          audio.play().catch(() => {});
        }
        break;
      case "SET_VOLUME":
        audio.volume = event.volume;
        break;
      case "SET_PLAYBACK_RATE":
        audio.playbackRate = event.rate;
        break;
      case "APPEND_FRAGMENT":
        // In stream mode, if we don't have an external URL, the blob grows.
        // We re-create the object URL.
        if (!input.audioUrl && event.blob) {
          const wasPlaying = !audio.paused;
          const currentTime = audio.currentTime;

          if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
          }
          currentObjectUrl = URL.createObjectURL(event.blob);
          audio.src = currentObjectUrl;
          audio.currentTime = currentTime;

          if (wasPlaying) {
            audio.play().catch(() => {});
          }
        }
        break;
      case "FINALIZE_STREAM":
        // No action needed for HTMLAudioElement
        break;
    }
  });

  return () => {
    disposed = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  };
});

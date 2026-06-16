import { fromCallback, type ActorRefFrom } from "xstate";

const AUDIO_SYNC_DRIFT_THRESHOLD_SECONDS = 0.5;

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
  | { type: "STARTED"; mediaRecorder: MediaRecorder; mimeType: string; startedAtMs: number }
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
            startedAtMs > 0
              ? Math.max(nextChunkStartTimeMs, Date.now() - startedAtMs)
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
          nextChunkStartTimeMs = 0;
          sendBack({ type: "STARTED", mediaRecorder, mimeType, startedAtMs });
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
 * Audio playback actor - manages HTMLAudioElement for robust synchronized playback
 */
export const audioPlaybackActor = fromCallback<
  AudioPlaybackEvent,
  AudioPlaybackInput,
  AudioPlaybackEmit
>(({ sendBack, receive, input }) => {
  let audio: HTMLAudioElement | null = null;
  let audioUrl: string | null = null;
  let activeBlob = input.blob;
  let targetTimeMs = input.startPositionMs;
  let requestedPlay = false;
  let volume = input.volume;
  let playbackRate = input.playbackRate;
  const streamMode = input.mode === "stream";
  let loadedUntilMs = input.loadedUntilMs ?? Number.POSITIVE_INFINITY;
  let startOffsetMs = input.startOffsetMs ?? 0;
  let finalized = input.finalized ?? !streamMode;
  let lastReadyDurationMs = -1;

  const cleanup = () => {
    if (audio) {
      audio.oncanplaythrough = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
      audio.load();
      audio = null;
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
  };

  const getElementTargetSeconds = (): number => {
    const effectiveTimelineMs =
      streamMode && !finalized ? Math.min(targetTimeMs, loadedUntilMs) : targetTimeMs;
    return Math.max(0, effectiveTimelineMs - startOffsetMs) / 1000;
  };

  const canPlayRequestedTime = (): boolean => {
    if (!streamMode) {
      return true;
    }

    if (targetTimeMs < startOffsetMs) {
      return false;
    }

    return finalized || loadedUntilMs >= targetTimeMs;
  };

  const applyTargetTime = (force = false) => {
    if (!audio) return;

    const targetSeconds = getElementTargetSeconds();
    if (
      force ||
      Math.abs(audio.currentTime - targetSeconds) >= AUDIO_SYNC_DRIFT_THRESHOLD_SECONDS
    ) {
      audio.currentTime = targetSeconds;
    }
  };

  const maybePlay = () => {
    if (!audio) return;

    if (!requestedPlay) {
      audio.pause();
      return;
    }

    if (!canPlayRequestedTime()) {
      audio.pause();
      return;
    }

    if (audio.paused) {
      audio.play().catch((err) => {
        console.warn("[AudioActor] Play failed:", err);
      });
    }
  };

  const reportReady = () => {
    if (!audio) return;

    const durationMs = streamMode
      ? Math.max(loadedUntilMs, startOffsetMs + audio.duration * 1000)
      : audio.duration * 1000;

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }

    if (Math.abs(durationMs - lastReadyDurationMs) < 1) {
      return;
    }

    lastReadyDurationMs = durationMs;
    sendBack({ type: "READY", duration: durationMs });
  };

  const attachBlob = (blob: Blob) => {
    try {
      cleanup();

      activeBlob = blob;
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      audio.volume = volume;
      audio.playbackRate = playbackRate;
      audio.currentTime = getElementTargetSeconds();

      audio.oncanplaythrough = () => {
        applyTargetTime(true);
        reportReady();
        maybePlay();
      };

      audio.onended = () => {
        if (streamMode && !finalized) {
          audio?.pause();
          return;
        }
        sendBack({ type: "FINISHED" });
      };

      audio.onerror = () => {
        if (streamMode && !finalized) {
          return;
        }
        sendBack({ type: "ERROR", error: "Audio playback error" });
      };
    } catch (error) {
      sendBack({
        type: "ERROR",
        error: error instanceof Error ? error.message : "Failed to initialize audio",
      });
    }
  };

  const init = () => {
    attachBlob(activeBlob);
  };

  init();

  receive((event) => {
    if (!audio) return;

    switch (event.type) {
      case "PLAY":
        requestedPlay = true;
        applyTargetTime(true);
        maybePlay();
        break;

      case "PAUSE":
        requestedPlay = false;
        audio.pause();
        break;

      case "SEEK":
        targetTimeMs = event.timeMs;
        applyTargetTime(true);
        maybePlay();
        break;

      case "SET_VOLUME":
        volume = Math.max(0, Math.min(1, event.volume));
        audio.volume = volume;
        break;

      case "SET_PLAYBACK_RATE":
        playbackRate = Number.isFinite(event.rate) && event.rate > 0 ? event.rate : 1;
        audio.playbackRate = playbackRate;
        break;

      case "SYNC": {
        targetTimeMs = event.timeMs;

        // Let the media element own small playback drift. Periodic timer-driven
        // nudges can send audio backward at higher speeds, but larger drift
        // still needs correction after tab throttling or seek races.
        applyTargetTime();
        maybePlay();

        break;
      }

      case "APPEND_FRAGMENT":
        if (!streamMode) {
          break;
        }

        activeBlob = event.blob;
        loadedUntilMs = Math.max(loadedUntilMs, event.loadedUntilMs);
        if (typeof event.finalized === "boolean") {
          finalized = event.finalized;
        }
        attachBlob(activeBlob);
        break;

      case "FINALIZE_STREAM":
        if (!streamMode) {
          break;
        }

        finalized = true;
        reportReady();
        maybePlay();
        break;
    }
  });

  return cleanup;
});

export type AudioRecordingActorRef = ActorRefFrom<typeof audioRecordingActor>;
export type AudioPlaybackActorRef = ActorRefFrom<typeof audioPlaybackActor>;

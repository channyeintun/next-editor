import { fromCallback } from "xstate";
import { getSupportedAudioMimeType } from "../utils/audioMimeType";
import { isAllowedRecordingMediaUrl } from "../utils/mediaUrl";
import {
  normalizeNonNegativeTime,
  normalizePlaybackSpeed,
  normalizePlaybackVolume,
} from "./playbackValues";

/**
 * Dead zone for the periodic SYNC safety net. Reseeking an HTMLAudioElement is
 * audible (a brief gap), so routine ticks only correct gross drift.
 */
const AUDIO_SYNC_DRIFT_THRESHOLD_MS = 500;

/**
 * Dead zone for explicit repositioning (spawn/SEEK/PLAY) and for the re-anchor
 * on the element's `playing` event. Kept just large enough to skip redundant
 * micro-seeks; anything above ~50ms is within lip-sync perceptibility, so these
 * paths correct it exactly instead of letting it persist under the SYNC
 * threshold.
 */
const AUDIO_EXACT_SYNC_EPSILON_MS = 50;

/**
 * MediaRecorder timeslice (ms). Emitting `ondataavailable` on an interval produces
 * live audio chunks (forwarded as `AUDIO_RECORDING_CHUNK`) for incremental persistence / streaming,
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
  /**
   * Audio blob used for immediate playback after recording, before the lesson
   * is published and an audioUrl is available. Always present; used as the
   * source when audioUrl is absent.
   */
  blob: Blob;
  /**
   * Permanent URL for the audio track, set after the lesson is published and
   * the audio is uploaded to storage. Takes precedence over the blob when
   * present. Absent for in-progress or unpublished recordings.
   */
  audioUrl?: string;
  /** Initial volume (0-1) */
  volume: number;
  /** Initial playback rate */
  playbackRate: number;
  /** Starting position in milliseconds */
  startPositionMs: number;
  /** Offset between the editor timeline origin and audio time 0. */
  startOffsetMs?: number;
}

export type AudioRecordingEvent = { type: "START" } | { type: "STOP" };

export type AudioPlaybackEvent =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; timeMs: number }
  | { type: "SET_VOLUME"; volume: number }
  | { type: "SET_PLAYBACK_RATE"; rate: number }
  | { type: "SYNC"; timeMs: number };

export type AudioRecordingEmit =
  | {
      type: "AUDIO_RECORDING_STARTED";
      mediaRecorder: MediaRecorder;
      mimeType: string;
      startedAtMs: number;
      startedAtPerf: number;
    }
  | {
      type: "AUDIO_RECORDING_CHUNK";
      chunk: Blob;
      startTimeMs: number;
      endTimeMs: number;
    }
  | { type: "AUDIO_RECORDING_STOPPED"; blob: Blob }
  | { type: "AUDIO_RECORDING_ERROR"; error: string };

export type AudioPlaybackEmit =
  | { type: "AUDIO_PLAYBACK_READY"; duration: number }
  | { type: "AUDIO_PLAYBACK_FINISHED" }
  | { type: "AUDIO_PLAYBACK_ERROR"; error: string };

// ============================================================================
// Audio Recording Actor
// ============================================================================

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
  let stopRequested = false;
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
    if (starting || stopRequested || mediaRecorder) {
      return;
    }

    starting = true;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: input.constraints ?? {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          // Use `ideal` (not exact) values so Brave's fingerprint shield and
          // other strict browsers can relax the constraint instead of rejecting
          // the request with OverconstrainedError / NotSupportedError.
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 16000 },
        },
      });

      if (disposed || stopRequested) {
        cleanupStream();
        return;
      }

      mimeType = getSupportedAudioMimeType();
      if (!mimeType) {
        cleanupStream();
        if (!disposed && !stopRequested) {
          sendBack({
            type: "AUDIO_RECORDING_ERROR",
            error: "No supported audio MIME type found",
          });
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
            type: "AUDIO_RECORDING_CHUNK",
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
          sendBack({ type: "AUDIO_RECORDING_STOPPED", blob });
        }

        cleanupStream();
      };

      mediaRecorder.onstart = () => {
        if (!disposed && !stopRequested && mediaRecorder) {
          startedAtMs = Date.now();
          startedAtPerfMs = performance.now();
          nextChunkStartTimeMs = 0;
          sendBack({
            type: "AUDIO_RECORDING_STARTED",
            mediaRecorder,
            mimeType,
            startedAtMs,
            startedAtPerf: startedAtPerfMs,
          });
        }
      };

      mediaRecorder.onerror = (event: Event) => {
        if (disposed || stopRequested) return;
        const recorderError = (event as Event & { error?: unknown }).error;
        sendBack({
          type: "AUDIO_RECORDING_ERROR",
          error: recorderError instanceof Error ? recorderError.message : "Audio recording error",
        });
      };

      // Timeslice so audio data is delivered incrementally as `AUDIO_RECORDING_CHUNK` events; the
      // final blob is still assembled from the same chunks on stop.
      mediaRecorder.start(AUDIO_TIMESLICE_MS);
    } catch (error) {
      cleanupStream();
      if (!disposed && !stopRequested) {
        sendBack({
          type: "AUDIO_RECORDING_ERROR",
          error: error instanceof Error ? error.message : "Failed to start recording",
        });
      }
    } finally {
      starting = false;
    }
  };

  const stopRecording = () => {
    stopRequested = true;
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
    stopRequested = true;
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
 * Pitch is preserved across playback-rate changes (native time-stretching).
 *
 * Sync model: the machine's timeline (rAF wall clock) is the master. The machine
 * reports timeline positions via SEEK (explicit) and SYNC (every ~250ms while
 * playing). Between reports the target is extrapolated at the playback rate, so
 * the re-anchor on the element's `playing` event — which fires only after
 * `play()`'s real startup latency — can seek to where the timeline actually is
 * by then, instead of freezing in the startup lag forever.
 */
export const audioPlaybackActor = fromCallback<
  AudioPlaybackEvent,
  AudioPlaybackInput,
  AudioPlaybackEmit
>(({ sendBack, receive, input }) => {
  let disposed = false;
  const startOffsetMs = normalizeNonNegativeTime(input.startOffsetMs ?? 0);
  let requestedPlay = false;
  // Timeline position last reported by the machine, and when it was reported.
  let lastKnownTimelineMs = normalizeNonNegativeTime(input.startPositionMs);
  let lastKnownAtPerf = performance.now();

  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preservesPitch = true;

  let currentObjectUrl: string | null = null;
  // The recording's audioUrl is decoded from the `.ne` header with no runtime
  // validation, so it is scheme-checked before it reaches `src`. A rejected URL
  // falls through to the local blob, which is the same path a recording with no
  // external audio already takes.
  if (isAllowedRecordingMediaUrl(input.audioUrl)) {
    audio.src = input.audioUrl;
  } else {
    currentObjectUrl = URL.createObjectURL(input.blob);
    audio.src = currentObjectUrl;
  }

  audio.volume = normalizePlaybackVolume(input.volume);
  audio.playbackRate = normalizePlaybackSpeed(input.playbackRate);

  const setKnownTimelineTime = (timeMs: number) => {
    lastKnownTimelineMs = normalizeNonNegativeTime(timeMs, lastKnownTimelineMs);
    lastKnownAtPerf = performance.now();
  };

  /** Where the machine's timeline is right now, extrapolated while playing. */
  const currentTargetMs = () => {
    const elapsed = requestedPlay ? (performance.now() - lastKnownAtPerf) * audio.playbackRate : 0;
    return lastKnownTimelineMs + elapsed;
  };

  const applyTargetTime = (driftThresholdMs: number) => {
    const targetSec = Math.max(0, currentTargetMs() - startOffsetMs) / 1000;
    if (Math.abs(audio.currentTime - targetSec) > driftThresholdMs / 1000) {
      audio.currentTime = targetSec;
    }
  };

  // Seek immediately on spawn if needed
  applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);

  audio.onplaying = () => {
    if (disposed) return;
    // Sound is actually flowing now — `play()` resolved some tens/hundreds of ms
    // after the timeline started, and the audio began from the pre-latency seek
    // position. Re-anchor to the extrapolated timeline so that startup lag does
    // not persist below the SYNC dead zone for the rest of playback. The seek
    // this triggers refires `playing`, but the residual drift is then just the
    // seek latency, which lands inside the epsilon and terminates the cycle.
    applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);
  };

  audio.oncanplay = () => {
    if (disposed) return;
    const durationMs =
      Number.isFinite(audio.duration) && !isNaN(audio.duration) ? audio.duration * 1000 : 0;
    sendBack({ type: "AUDIO_PLAYBACK_READY", duration: durationMs });
  };

  audio.onended = () => {
    if (disposed) return;
    sendBack({ type: "AUDIO_PLAYBACK_FINISHED" });
  };

  audio.onerror = () => {
    if (disposed) return;
    sendBack({ type: "AUDIO_PLAYBACK_ERROR", error: "Audio playback error" });
  };

  receive((event) => {
    if (disposed) return;

    switch (event.type) {
      case "PLAY":
        requestedPlay = true;
        // Exact re-align at (re)start: a pause can leave the element a few
        // hundred ms off the timeline, and letting that ride under the SYNC
        // dead zone would accumulate more lag with every play/pause cycle.
        applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);
        audio.play().catch(() => {});
        break;
      case "PAUSE":
        // Freeze extrapolation at the current target before clearing the flag.
        setKnownTimelineTime(currentTargetMs());
        requestedPlay = false;
        audio.pause();
        break;
      case "SEEK":
        // Explicit repositioning is exact — even a sub-500ms nudge must move the audio.
        setKnownTimelineTime(event.timeMs);
        applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);
        break;
      case "SYNC":
        setKnownTimelineTime(event.timeMs);
        applyTargetTime(AUDIO_SYNC_DRIFT_THRESHOLD_MS);
        if (requestedPlay && audio.paused) {
          audio.play().catch(() => {});
        }
        break;
      case "SET_VOLUME":
        audio.volume = normalizePlaybackVolume(event.volume, audio.volume);
        break;
      case "SET_PLAYBACK_RATE":
        // Re-anchor with the old rate first so the elapsed-time extrapolation
        // never applies the new rate to the interval before the change.
        setKnownTimelineTime(currentTargetMs());
        audio.playbackRate = normalizePlaybackSpeed(event.rate, audio.playbackRate);
        break;
    }
  });

  return () => {
    disposed = true;
    audio.pause();
    audio.removeAttribute("src");
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  };
});

import { fromCallback, type ActorRefFrom } from "xstate";

const AUDIO_SYNC_DRIFT_THRESHOLD_MS = 500;
const STREAM_BUFFER_SWITCH_LOOKAHEAD_MS = 1000;

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
  let activeBlob = input.blob;
  let audioContext: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let sourceNode: AudioBufferSourceNode | null = null;
  let activeBuffer: AudioBuffer | null = null;
  let pendingBuffer: AudioBuffer | null = null;
  let pendingBufferLoadedUntilMs = input.loadedUntilMs ?? Number.POSITIVE_INFINITY;
  let targetTimeMs = input.startPositionMs;
  let requestedPlay = false;
  let volume = input.volume;
  let playbackRate = input.playbackRate;
  const streamMode = input.mode === "stream";
  let loadedUntilMs = input.loadedUntilMs ?? Number.POSITIVE_INFINITY;
  let activeBufferLoadedUntilMs = loadedUntilMs;
  let startOffsetMs = input.startOffsetMs ?? 0;
  let finalized = input.finalized ?? !streamMode;
  let lastReadyDurationMs = -1;
  let playStartedAtContextTime = 0;
  let playStartedAtTimelineMs = targetTimeMs;
  let decodeSerial = 0;
  let disposed = false;

  const cleanup = () => {
    disposed = true;
    stopSource();
    gainNode?.disconnect();
    gainNode = null;
    if (audioContext) {
      void audioContext.close().catch(() => {});
      audioContext = null;
    }
  };

  const getAudioContext = (): AudioContext | null => {
    if (audioContext) {
      return audioContext;
    }

    const AudioContextCtor =
      globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) {
      sendBack({ type: "ERROR", error: "Web Audio is not supported" });
      return null;
    }

    audioContext = new AudioContextCtor();
    gainNode = audioContext.createGain();
    gainNode.gain.value = volume;
    gainNode.connect(audioContext.destination);
    return audioContext;
  };

  const getTargetOffsetSeconds = (): number => {
    return Math.max(0, targetTimeMs - startOffsetMs) / 1000;
  };

  const getSourceTimelineTime = (): number => {
    if (!audioContext || !sourceNode) {
      return targetTimeMs;
    }

    return (
      playStartedAtTimelineMs +
      (audioContext.currentTime - playStartedAtContextTime) * playbackRate * 1000
    );
  };

  const canPlayRequestedTime = (): boolean => {
    if (!activeBuffer) {
      return false;
    }

    if (!streamMode) {
      return true;
    }

    if (targetTimeMs < startOffsetMs) {
      return false;
    }

    return finalized || activeBufferLoadedUntilMs >= targetTimeMs;
  };

  const stopSource = () => {
    if (!sourceNode) {
      return;
    }

    const source = sourceNode;
    sourceNode = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  };

  const shouldActivatePendingBuffer = (force = false): boolean => {
    if (!pendingBuffer) {
      return false;
    }

    if (!activeBuffer || force || finalized) {
      return true;
    }

    return targetTimeMs >= activeBufferLoadedUntilMs - STREAM_BUFFER_SWITCH_LOOKAHEAD_MS;
  };

  const activatePendingBuffer = (force = false): boolean => {
    if (!shouldActivatePendingBuffer(force) || !pendingBuffer) {
      return false;
    }

    activeBuffer = pendingBuffer;
    activeBufferLoadedUntilMs = pendingBufferLoadedUntilMs;
    pendingBuffer = null;
    return true;
  };

  const reportReady = () => {
    if (!activeBuffer) return;

    const durationMs = streamMode
      ? Math.max(activeBufferLoadedUntilMs, startOffsetMs + activeBuffer.duration * 1000)
      : activeBuffer.duration * 1000;

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }

    if (Math.abs(durationMs - lastReadyDurationMs) < 1) {
      return;
    }

    lastReadyDurationMs = durationMs;
    sendBack({ type: "READY", duration: durationMs });
  };

  const startSource = () => {
    const context = getAudioContext();
    if (!context || !gainNode || !activeBuffer || !canPlayRequestedTime()) {
      return;
    }

    const offsetSeconds = getTargetOffsetSeconds();
    if (offsetSeconds >= activeBuffer.duration) {
      return;
    }

    stopSource();

    const source = context.createBufferSource();
    source.buffer = activeBuffer;
    source.playbackRate.value = playbackRate;
    source.connect(gainNode);
    source.onended = () => {
      if (sourceNode !== source) {
        return;
      }
      sourceNode = null;

      if (streamMode && activatePendingBuffer(true)) {
        startSource();
        return;
      }

      if (streamMode && !finalized) {
        return;
      }

      sendBack({ type: "FINISHED" });
    };

    playStartedAtTimelineMs = targetTimeMs;
    playStartedAtContextTime = context.currentTime;
    sourceNode = source;
    source.start(0, offsetSeconds);
  };

  const maybePlay = () => {
    const context = getAudioContext();
    if (!context) return;

    if (!requestedPlay) {
      stopSource();
      return;
    }

    activatePendingBuffer();

    if (!canPlayRequestedTime()) {
      stopSource();
      return;
    }

    void context.resume().catch((err) => {
      console.warn("[AudioActor] AudioContext resume failed:", err);
    });

    if (!sourceNode) {
      startSource();
    }
  };

  const applyTargetTime = (force = false) => {
    if (!sourceNode) {
      return;
    }

    const currentTimelineMs = getSourceTimelineTime();
    const driftMs = Math.abs(currentTimelineMs - targetTimeMs);

    if (force || driftMs >= AUDIO_SYNC_DRIFT_THRESHOLD_MS) {
      startSource();
    }
  };

  const decodeBlob = (blob: Blob, nextLoadedUntilMs: number, forceActivate = false) => {
    try {
      activeBlob = blob;
      const context = getAudioContext();
      if (!context) {
        return;
      }
      const serial = ++decodeSerial;

      void blob
        .arrayBuffer()
        .then((arrayBuffer) => context.decodeAudioData(arrayBuffer.slice(0)))
        .then((buffer) => {
          if (disposed || serial !== decodeSerial) {
            return;
          }

          pendingBuffer = buffer;
          pendingBufferLoadedUntilMs = nextLoadedUntilMs;

          if (activatePendingBuffer(forceActivate)) {
            reportReady();
            if (requestedPlay) {
              startSource();
            }
            return;
          }

          reportReady();
          maybePlay();
        })
        .catch((error) => {
          if (disposed || (streamMode && !finalized)) {
            return;
          }

          sendBack({
            type: "ERROR",
            error: error instanceof Error ? error.message : "Audio decode failed",
          });
        });
    } catch (error) {
      if (streamMode && !finalized) {
        return;
      }

      sendBack({
        type: "ERROR",
        error: error instanceof Error ? error.message : "Failed to initialize audio",
      });
    }
  };

  const updatePlaybackRate = (rate: number) => {
    playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    if (sourceNode) {
      playStartedAtTimelineMs = getSourceTimelineTime();
      playStartedAtContextTime = audioContext?.currentTime ?? 0;
      sourceNode.playbackRate.value = playbackRate;
    }
  };

  const updateVolume = (nextVolume: number) => {
    volume = Math.max(0, Math.min(1, nextVolume));
    if (gainNode) {
      gainNode.gain.value = volume;
    }
  };

  const seekTo = (timeMs: number, forceBuffer = false) => {
    targetTimeMs = timeMs;
    activatePendingBuffer(forceBuffer || targetTimeMs > activeBufferLoadedUntilMs);
    if (requestedPlay) {
      startSource();
    }
  };

  const init = () => {
    decodeBlob(activeBlob, loadedUntilMs, true);
  };

  init();

  receive((event) => {
    switch (event.type) {
      case "PLAY":
        requestedPlay = true;
        maybePlay();
        break;

      case "PAUSE":
        requestedPlay = false;
        stopSource();
        break;

      case "SEEK":
        seekTo(event.timeMs, true);
        break;

      case "SET_VOLUME":
        updateVolume(event.volume);
        break;

      case "SET_PLAYBACK_RATE":
        updatePlaybackRate(event.rate);
        break;

      case "SYNC": {
        targetTimeMs = event.timeMs;
        activatePendingBuffer();
        applyTargetTime();
        maybePlay();

        break;
      }

      case "APPEND_FRAGMENT":
        if (!streamMode) {
          break;
        }

        loadedUntilMs = Math.max(loadedUntilMs, event.loadedUntilMs);
        if (typeof event.finalized === "boolean") {
          finalized = event.finalized;
        }

        decodeBlob(event.blob, loadedUntilMs, event.finalized || !activeBuffer);
        break;

      case "FINALIZE_STREAM":
        if (!streamMode) {
          break;
        }

        finalized = true;
        activatePendingBuffer(true);
        reportReady();
        maybePlay();
        break;
    }
  });

  return cleanup;
});

export type AudioRecordingActorRef = ActorRefFrom<typeof audioRecordingActor>;
export type AudioPlaybackActorRef = ActorRefFrom<typeof audioPlaybackActor>;

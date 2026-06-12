import { fromCallback, type ActorRefFrom } from "xstate";

// ============================================================================
// Audio Actor Types
// ============================================================================

export interface AudioRecordingInput {
  /** Audio constraints */
  constraints?: MediaTrackConstraints;
}

export interface AudioPlaybackInput {
  /** Audio blob to play */
  blob: Blob;
  /** Initial volume (0-1) */
  volume: number;
  /** Initial playback rate */
  playbackRate: number;
  /** Starting position in milliseconds */
  startPositionMs: number;
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
  | { type: "STARTED"; mediaRecorder: MediaRecorder; mimeType: string }
  | { type: "CHUNK"; chunk: Blob }
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
          chunks.push(event.data);
          sendBack({ type: "CHUNK", chunk: event.data });
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
          sendBack({ type: "STARTED", mediaRecorder, mimeType });
        }
      };

      mediaRecorder.start();
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

  const init = () => {
    try {
      audioUrl = URL.createObjectURL(input.blob);
      audio = new Audio(audioUrl);
      audio.volume = input.volume;
      audio.playbackRate = input.playbackRate;
      audio.currentTime = input.startPositionMs / 1000;

      audio.oncanplaythrough = () => {
        if (audio) {
          sendBack({ type: "READY", duration: audio.duration * 1000 });
        }
      };

      audio.onended = () => {
        sendBack({ type: "FINISHED" });
      };

      audio.onerror = () => {
        sendBack({ type: "ERROR", error: "Audio playback error" });
      };

      // For iOS, we might need a user gesture to start,
      // but the machine handles PLAY event on user gesture.
    } catch (error) {
      sendBack({
        type: "ERROR",
        error: error instanceof Error ? error.message : "Failed to initialize audio",
      });
    }
  };

  init();

  receive((event) => {
    if (!audio) return;

    switch (event.type) {
      case "PLAY":
        if (audio.paused) {
          audio.play().catch((err) => {
            // On some browsers, play() might fail if not triggered by user gesture
            // even if the AudioContext was unlocked.
            console.warn("[AudioActor] Play failed:", err);
          });
        }
        break;

      case "PAUSE":
        audio.pause();
        break;

      case "SEEK":
        audio.currentTime = event.timeMs / 1000;
        break;

      case "SET_VOLUME":
        audio.volume = Math.max(0, Math.min(1, event.volume));
        break;

      case "SET_PLAYBACK_RATE":
        audio.playbackRate = Number.isFinite(event.rate) && event.rate > 0 ? event.rate : 1;
        break;

      case "SYNC": {
        // Let the media element own playback time. Periodic timer-driven
        // currentTime nudges can send the audio slightly backward at higher speeds.
        break;
      }
    }
  });

  return cleanup;
});

export type AudioRecordingActorRef = ActorRefFrom<typeof audioRecordingActor>;
export type AudioPlaybackActorRef = ActorRefFrom<typeof audioPlaybackActor>;

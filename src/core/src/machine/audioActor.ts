import { fromCallback, type ActorRefFrom } from "xstate";
import { getAudioContext } from "../utils/audioContext";

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

type PitchPreservingAudioElement = HTMLAudioElement & {
  preservesPitch?: boolean;
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

type SoundTouchNodeConstructor = typeof import("@soundtouchjs/audio-worklet").SoundTouchNode;
type SoundTouchNodeInstance = InstanceType<SoundTouchNodeConstructor>;

let soundTouchLoader: Promise<{
  SoundTouchNode: SoundTouchNodeConstructor;
  processorUrl: string;
}> | null = null;
const soundTouchRegistrations = new WeakMap<BaseAudioContext, Promise<void>>();

const loadSoundTouch = async () => {
  if (!soundTouchLoader) {
    soundTouchLoader = Promise.all([
      import("@soundtouchjs/audio-worklet"),
      import("@soundtouchjs/audio-worklet/processor?url"),
    ]).then(([module, processor]) => ({
      SoundTouchNode: module.SoundTouchNode,
      processorUrl: processor.default,
    }));
  }

  return soundTouchLoader;
};

const registerSoundTouch = async (context: BaseAudioContext) => {
  const { SoundTouchNode, processorUrl } = await loadSoundTouch();
  let registration = soundTouchRegistrations.get(context);

  if (!registration) {
    registration = SoundTouchNode.register(context, processorUrl);
    soundTouchRegistrations.set(context, registration);
  }

  await registration;
  return SoundTouchNode;
};

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
  let audioContext: AudioContext | null = null;
  let mediaElementSource: MediaElementAudioSourceNode | null = null;
  let soundTouchNode: SoundTouchNodeInstance | null = null;
  let gainNode: GainNode | null = null;
  let soundTouchSetup: Promise<void> | null = null;
  let disposed = false;
  let wantsPlaying = false;
  let currentVolume = Math.max(0, Math.min(1, input.volume));
  let currentPlaybackRate =
    Number.isFinite(input.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1;

  const applyPitchPreservation = (preservePitch: boolean) => {
    if (!audio) return;

    const pitchAudio = audio as PitchPreservingAudioElement;
    pitchAudio.preservesPitch = preservePitch;
    pitchAudio.mozPreservesPitch = preservePitch;
    pitchAudio.webkitPreservesPitch = preservePitch;
  };

  const applyVolume = () => {
    if (!audio) return;

    if (gainNode) {
      audio.volume = 1;
      gainNode.gain.value = currentVolume;
    } else {
      audio.volume = currentVolume;
    }
  };

  const applyPlaybackRate = (rate: number) => {
    if (!audio) return;

    const playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    currentPlaybackRate = playbackRate;

    audio.playbackRate = playbackRate;
    if (soundTouchNode) {
      // SoundTouch handles pitch correction. Native pitch preservation
      // must stay disabled to avoid double processing and echo.
      applyPitchPreservation(false);
      soundTouchNode.playbackRate.value = playbackRate;
      soundTouchNode.pitch.value = 1;
      soundTouchNode.pitchSemitones.value = 0;
    } else {
      // Fallback path: preserve pitch natively rather than raising it.
      applyPitchPreservation(true);
    }
  };

  const setupSoundTouch = async () => {
    if (!audio || typeof window === "undefined" || !("AudioWorkletNode" in window)) {
      applyPlaybackRate(currentPlaybackRate);
      return;
    }

    try {
      audioContext = getAudioContext();
      if (!audioContext.audioWorklet) {
        applyPlaybackRate(currentPlaybackRate);
        return;
      }

      const SoundTouchNode = await registerSoundTouch(audioContext);
      if (!audio || disposed) return;

      const nextSoundTouchNode = new SoundTouchNode({
        context: audioContext,
      });
      const nextGainNode = audioContext.createGain();
      const nextSource = audioContext.createMediaElementSource(audio);

      nextSoundTouchNode.setStretchParameters({
        overlapMs: 12,
        quickSeek: false,
      });

      nextSource.connect(nextSoundTouchNode);
      nextSoundTouchNode.connect(nextGainNode);
      nextGainNode.connect(audioContext.destination);

      mediaElementSource = nextSource;
      soundTouchNode = nextSoundTouchNode;
      gainNode = nextGainNode;

      applyVolume();
      applyPlaybackRate(currentPlaybackRate);
    } catch (error) {
      console.warn("[AudioActor] SoundTouch setup failed, using native playback:", error);
      try {
        mediaElementSource?.disconnect();
        soundTouchNode?.disconnect();
        gainNode?.disconnect();
      } catch {
        // Ignore partial graph cleanup failures.
      }
      mediaElementSource = null;
      soundTouchNode = null;
      gainNode = null;
      applyVolume();
      applyPlaybackRate(currentPlaybackRate);
    }
  };

  const playAudio = async () => {
    if (!audio || !wantsPlaying) return;

    if (soundTouchSetup) {
      await soundTouchSetup.catch(() => undefined);
    }

    if (!audio || !wantsPlaying || disposed) return;

    if (audioContext) {
      await audioContext.resume().catch(() => undefined);
    }

    if (audio.paused) {
      audio.play().catch((err) => {
        // On some browsers, play() might fail if not triggered by user gesture
        // even if the AudioContext was unlocked.
        console.warn("[AudioActor] Play failed:", err);
      });
    }
  };

  const cleanup = () => {
    disposed = true;
    wantsPlaying = false;
    try {
      mediaElementSource?.disconnect();
      soundTouchNode?.disconnect();
      gainNode?.disconnect();
    } catch {
      // Ignore graph cleanup failures while tearing down playback.
    }
    mediaElementSource = null;
    soundTouchNode = null;
    gainNode = null;
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
      applyVolume();
      applyPlaybackRate(currentPlaybackRate);
      audio.currentTime = input.startPositionMs / 1000;
      soundTouchSetup = setupSoundTouch();

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
        wantsPlaying = true;
        void playAudio();
        break;

      case "PAUSE":
        wantsPlaying = false;
        audio.pause();
        break;

      case "SEEK":
        audio.currentTime = event.timeMs / 1000;
        break;

      case "SET_VOLUME":
        currentVolume = Math.max(0, Math.min(1, event.volume));
        applyVolume();
        break;

      case "SET_PLAYBACK_RATE":
        applyPlaybackRate(event.rate);
        break;

      case "SYNC": {
        if (audio.paused) {
          break;
        }

        const targetTime = event.timeMs / 1000;
        const diff = Math.abs(audio.currentTime - targetTime);
        const syncDriftThresholdSeconds = Math.max(0.35, 0.2 * audio.playbackRate);

        // Keep sync correction coarse. Frequent tiny seeks at high speed
        // can sound like echoing or repeated syllables in HTMLAudioElement.
        if (diff > syncDriftThresholdSeconds) {
          audio.currentTime = targetTime;
        }
        break;
      }
    }
  });

  return cleanup;
});

export type AudioRecordingActorRef = ActorRefFrom<typeof audioRecordingActor>;
export type AudioPlaybackActorRef = ActorRefFrom<typeof audioPlaybackActor>;

import { fromCallback, type ActorRefFrom } from "xstate";

/**
 * SoundTouch (WSOLA) is loaded lazily and only used to preserve pitch when audio
 * plays off-speed. An `AudioBufferSourceNode` resamples on `playbackRate`, which
 * couples tempo and pitch (2x speed = +1 octave); SoundTouch cancels that
 * tempo-induced pitch shift. Module load and per-`AudioContext` registration are
 * cached so repeated playback actors share the work.
 */
type SoundTouchNodeCtor = typeof import("@soundtouchjs/audio-worklet").SoundTouchNode;

let soundTouchLoader: Promise<{
  SoundTouchNode: SoundTouchNodeCtor;
  processorUrl: string;
}> | null = null;
const soundTouchRegistrations = new WeakMap<BaseAudioContext, Promise<SoundTouchNodeCtor>>();

const loadSoundTouch = () => {
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

const registerSoundTouch = (context: BaseAudioContext): Promise<SoundTouchNodeCtor> => {
  let registration = soundTouchRegistrations.get(context);

  if (!registration) {
    registration = loadSoundTouch().then(async ({ SoundTouchNode, processorUrl }) => {
      await SoundTouchNode.register(context, processorUrl);
      return SoundTouchNode;
    });
    soundTouchRegistrations.set(context, registration);
  }

  return registration;
};

const AUDIO_SYNC_DRIFT_THRESHOLD_MS = 500;
const STREAM_BUFFER_SWITCH_LOOKAHEAD_MS = 1000;

/**
 * Length of the gain ramp applied when a source is started or stopped on a
 * seek/restart. Cutting an `AudioBufferSourceNode` mid-waveform (or starting one
 * mid-cycle at a new offset) produces an audible click; ramping over a few
 * milliseconds turns the restart into an inaudible crossfade. Long enough to span
 * a low-frequency cycle, short enough to feel instant.
 */
const DECLICK_FADE_SECONDS = 0.02;

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
// Audio Playback Actor Helpers
// ============================================================================

/**
 * Safely stops an AudioBufferSourceNode, ignoring any errors if it is already stopped.
 */
const safeStop = (source?: AudioBufferSourceNode | null) => {
  if (source) {
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  }
};

/**
 * Safely disconnects an AudioNode, ignoring any errors if it is already disconnected.
 */
const safeDisconnect = (node?: AudioNode | null) => {
  if (node) {
    try {
      node.disconnect();
    } catch {
      // Already disconnected.
    }
  }
};

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
  let pitchShiftNode: InstanceType<SoundTouchNodeCtor> | null = null;
  let envelopeNode: GainNode | null = null;
  let soundTouchNodeCtor: SoundTouchNodeCtor | null = null;
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

  /**
   * Ghost sources: AudioBufferSourceNodes that have been detached from `sourceNode`
   * and are currently fading out. Tracking them here lets us immediately hard-stop
   * all lingering ghosts when a new seek arrives, preventing echo/chorus buildup
   * from rapid consecutive seeks where multiple fades overlap.
   */
  type LingeringNode = {
    source: AudioBufferSourceNode;
    envelope: GainNode;
    shifter: InstanceType<SoundTouchNodeCtor> | null;
  };
  const lingeringNodes = new Set<LingeringNode>();

  const killLingeringNodes = () => {
    for (const ghost of lingeringNodes) {
      safeStop(ghost.source);
      safeDisconnect(ghost.source);
      safeDisconnect(ghost.shifter);
      safeDisconnect(ghost.envelope);
    }
    lingeringNodes.clear();
  };

  const cleanup = () => {
    disposed = true;
    killLingeringNodes();
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
    ensurePitchShifter(audioContext);
    return audioContext;
  };

  /**
   * Loads + registers the SoundTouch worklet used for pitch preservation. Runs in
   * the background; until it resolves, off-speed audio plays without pitch
   * correction (native resampled behavior) and is upgraded in place the moment the
   * node becomes available. A no-op when Web Audio worklets are unavailable.
   */
  const ensurePitchShifter = (context: AudioContext) => {
    if (soundTouchNodeCtor || typeof AudioWorkletNode === "undefined" || !context.audioWorklet) {
      return;
    }

    void registerSoundTouch(context)
      .then((Ctor) => {
        if (disposed) {
          return;
        }
        soundTouchNodeCtor = Ctor;
        // Registration finished after playback already began off-speed: rebuild the
        // source from its current position so the pitch is corrected from here on.
        if (requestedPlay && sourceNode && playbackRate !== 1 && !pitchShiftNode) {
          targetTimeMs = getSourceTimelineTime();
          startSource();
        }
      })
      .catch((error) => {
        console.warn("[AudioActor] Pitch preservation unavailable:", error);
      });
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

  const stopSource = ({ fade = false }: { fade?: boolean } = {}) => {
    if (!sourceNode) {
      // No active source, but a detached pitch shifter could still linger. Discard
      // it so its WSOLA buffer can't replay stale samples on the next start.
      safeDisconnect(pitchShiftNode);
      pitchShiftNode = null;
      return;
    }

    // Detach the whole per-source graph at once so it can finish its fade
    // independently while a fresh source takes over. A new node per start still
    // means no stale WSOLA samples survive a seek (the cause of the previous echo).
    const source = sourceNode;
    const shifter = pitchShiftNode;
    const envelope = envelopeNode;
    sourceNode = null;
    pitchShiftNode = null;
    envelopeNode = null;
    source.onended = null;

    const disconnectGraph = () => {
      safeDisconnect(source);
      safeDisconnect(shifter);
      safeDisconnect(envelope);
    };

    // Declick: ramp this source to silence over a few milliseconds and stop it
    // once the ramp completes, instead of cutting the waveform instantly (an
    // audible click, and a burst of them while scrubbing).
    //
    // The ghost is registered in `lingeringNodes` so that rapid consecutive seeks
    // can immediately kill all lingering fades — preventing echo buildup where
    // multiple ghost sources overlap and play simultaneously.
    if (fade && audioContext && envelope) {
      const now = audioContext.currentTime;
      const stopAt = now + DECLICK_FADE_SECONDS;
      try {
        envelope.gain.cancelScheduledValues(now);
        envelope.gain.setValueAtTime(envelope.gain.value, now);
        envelope.gain.linearRampToValueAtTime(0, stopAt);

        const ghost: LingeringNode = { source, envelope, shifter };
        lingeringNodes.add(ghost);
        source.onended = () => {
          lingeringNodes.delete(ghost);
          disconnectGraph();
        };
        source.stop(stopAt);
        return;
      } catch {
        // AudioParam/stop scheduling unavailable; fall through to a hard stop.
      }
    }

    safeStop(source);
    disconnectGraph();
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

    // Kill any ghost sources from previous seeks before starting the new one.
    // Without this, rapid seeks accumulate overlapping fade-out nodes that play
    // concurrently and produce an audible echo/chorus effect.
    killLingeringNodes();
    stopSource({ fade: true });

    const source = context.createBufferSource();
    source.buffer = activeBuffer;
    source.playbackRate.value = playbackRate;

    // Pitch preservation: `AudioBufferSourceNode.playbackRate` resamples, shifting
    // pitch along with tempo (2x speed raises pitch an octave). When off-speed,
    // route through a SoundTouch node whose `playbackRate` is set to the same value
    // so it cancels exactly that tempo-induced pitch shift, leaving voices natural.
    // A fresh node per source start means no stale samples survive a seek. At 1x we
    // bypass it so the normal path stays byte-for-byte native.
    let tail: AudioNode = source;
    if (playbackRate !== 1 && soundTouchNodeCtor) {
      try {
        const PitchShifter = soundTouchNodeCtor;
        const shifter = new PitchShifter({
          context,
          outputChannelCount: activeBuffer.numberOfChannels >= 2 ? 2 : 1,
        });
        shifter.playbackRate.value = playbackRate;
        shifter.pitch.value = 1;
        shifter.pitchSemitones.value = 0;
        source.connect(shifter);
        pitchShiftNode = shifter;
        tail = shifter;
      } catch (error) {
        console.warn("[AudioActor] Pitch shifter init failed, using native playback:", error);
        pitchShiftNode = null;
        tail = source;
      }
    }

    // Per-source envelope between the source graph and the master volume so this
    // source can fade in while the previous one (if any) fades out — turning the
    // otherwise-clicky seek/restart into a short crossfade. Master volume stays on
    // `gainNode`, so the two multiply and the resulting level is unchanged.
    const envelope = context.createGain();
    const fadeStartTime = context.currentTime;
    envelope.gain.setValueAtTime(0, fadeStartTime);
    envelope.gain.linearRampToValueAtTime(1, fadeStartTime + DECLICK_FADE_SECONDS);

    tail.connect(envelope);
    envelope.connect(gainNode);
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
    playStartedAtContextTime = fadeStartTime;
    sourceNode = source;
    envelopeNode = envelope;
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
    const nextRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const prevRate = playbackRate;

    if (nextRate === prevRate) {
      return;
    }

    // Crossing the 1x boundary changes the graph topology (the pitch shifter only
    // exists off-speed), so rebuild the source from its current position. Any other
    // change just updates the live AudioParams for a smooth, gap-free speed change.
    const crossesBypassBoundary = (prevRate === 1) !== (nextRate === 1);

    if (sourceNode && crossesBypassBoundary) {
      targetTimeMs = getSourceTimelineTime();
      playbackRate = nextRate;
      startSource();
      return;
    }

    if (sourceNode) {
      playStartedAtTimelineMs = getSourceTimelineTime();
      playStartedAtContextTime = audioContext?.currentTime ?? 0;
    }
    playbackRate = nextRate;
    if (sourceNode) {
      sourceNode.playbackRate.value = nextRate;
      // Keep the pitch compensation locked to the source's tempo.
      if (pitchShiftNode) {
        pitchShiftNode.playbackRate.value = nextRate;
      }
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

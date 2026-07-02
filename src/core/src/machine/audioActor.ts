import { fromCallback, type ActorRefFrom } from "xstate";
import { canUseStretch, getStretchNode, type StretchNode } from "./stretchAudio";

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
 * Audio playback actor — plays recording audio through a Web Audio graph, synchronized to the
 * editor timeline. At 1x it plays a plain `AudioBufferSourceNode` (byte-for-byte native). Off
 * speed it drives a single-stage Signalsmith Stretch time-stretch (see {@link getStretchNode}),
 * which changes tempo without touching pitch — replacing the previous resample-plus-correct
 * SoundTouch chain whose double processing sounded unnatural at 2x.
 */
export const audioPlaybackActor = fromCallback<
  AudioPlaybackEvent,
  AudioPlaybackInput,
  AudioPlaybackEmit
>(({ sendBack, receive, input }) => {
  let activeBlob = input.blob;
  let audioContext: AudioContext | null = null;
  let gainNode: GainNode | null = null;

  // Native (1x) engine.
  let sourceNode: AudioBufferSourceNode | null = null;
  let envelopeNode: GainNode | null = null;

  // Stretch (off-speed) engine — a single reusable node per AudioContext.
  let stretchNode: StretchNode | null = null;
  let stretchReady = false;
  let stretchLoading = false;
  let stretchActive = false;
  // Both created lazily on first stretch use and left connected for the actor's lifetime — the
  // node is a single continuous player, not a per-start disposable (see `startStretchSource`).
  let stretchEnvelope: GainNode | null = null;
  let stretchConnected = false;
  let stretchLoadedBuffer: AudioBuffer | null = null;

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
   * Ghost graphs: native source/envelope pairs that have been detached and are fading out.
   * Tracking them lets a new seek immediately hard-stop every lingering fade, preventing
   * echo/chorus buildup when rapid consecutive seeks overlap their fade-outs. The stretch engine
   * has no equivalent — it reuses one persistent node/envelope instead of spawning new ones.
   */
  type LingeringNode = {
    source: AudioBufferSourceNode;
    envelope: GainNode;
  };
  const lingeringNodes = new Set<LingeringNode>();

  const killLingeringNodes = () => {
    for (const ghost of lingeringNodes) {
      safeStop(ghost.source);
      safeDisconnect(ghost.source);
      safeDisconnect(ghost.envelope);
    }
    lingeringNodes.clear();
  };

  const isPlaying = (): boolean => sourceNode !== null || stretchActive;

  const cleanup = () => {
    disposed = true;
    killLingeringNodes();
    stopSource();
    if (stretchNode) {
      safeDisconnect(stretchNode);
    }
    if (stretchEnvelope) {
      safeDisconnect(stretchEnvelope);
    }
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
    // The stretch worklet is created lazily (from `startSource`, only when playbackRate !== 1)
    // rather than here, so 1x playback never pays for a worklet it doesn't use.
    return audioContext;
  };

  /**
   * Position reached, in editor-timeline ms. Both engines advance the timeline at
   * `rate * wallclock` (native resamples the source; stretch stretches time), so the same
   * clock math serves both.
   */
  const getSourceTimelineTime = (): number => {
    if (!audioContext || !isPlaying()) {
      return targetTimeMs;
    }

    return (
      playStartedAtTimelineMs +
      (audioContext.currentTime - playStartedAtContextTime) * playbackRate * 1000
    );
  };

  const getTargetOffsetSeconds = (): number => {
    return Math.max(0, targetTimeMs - startOffsetMs) / 1000;
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

  /**
   * Lazily creates the Stretch node for this context. Runs in the background; until it resolves,
   * off-speed audio plays on the native fallback (resampled, so briefly pitched) and is upgraded
   * in place the moment the node is ready. A no-op where AudioWorklet is unavailable — playback
   * then stays on the native resample path.
   */
  const ensureStretchNode = (context: AudioContext) => {
    if (stretchNode || stretchLoading || !canUseStretch() || !context.audioWorklet) {
      return;
    }
    stretchLoading = true;
    void getStretchNode(context)
      .then((node) => {
        if (disposed) {
          safeDisconnect(node);
          return;
        }
        stretchNode = node;
        stretchReady = true;
        void node.setUpdateInterval(0.1, onStretchTimeUpdate);
        // Ready after off-speed playback already began on the native fallback: switch to the
        // stretch engine from the current position so pitch is corrected from here on.
        if (requestedPlay && playbackRate !== 1 && !stretchActive) {
          targetTimeMs = getSourceTimelineTime();
          startSource();
        }
      })
      .catch((error) => {
        console.warn("[AudioActor] Stretch time-stretch unavailable:", error);
      })
      .finally(() => {
        stretchLoading = false;
      });
  };

  /** Emitted stretch playhead updates: detect end-of-buffer (there is no `onended`). */
  const onStretchTimeUpdate = (inputSeconds: number) => {
    if (disposed || !stretchActive || !activeBuffer) {
      return;
    }
    if (finalized && inputSeconds >= activeBuffer.duration - 0.06) {
      stopStretchSource({});
      if (streamMode && activatePendingBuffer(true)) {
        startSource();
        return;
      }
      sendBack({ type: "FINISHED" });
    }
  };

  const stopNativeSource = ({ fade = false }: { fade?: boolean } = {}) => {
    if (!sourceNode) {
      return;
    }

    const source = sourceNode;
    const envelope = envelopeNode;
    sourceNode = null;
    envelopeNode = null;
    source.onended = null;

    const disconnectGraph = () => {
      safeDisconnect(source);
      safeDisconnect(envelope);
    };

    // Declick: ramp to silence over a few ms and stop once the ramp completes, instead of
    // cutting the waveform instantly. The ghost is tracked so rapid seeks can kill all
    // lingering fades before they overlap.
    if (fade && audioContext && envelope) {
      const now = audioContext.currentTime;
      const stopAt = now + DECLICK_FADE_SECONDS;
      try {
        envelope.gain.cancelScheduledValues(now);
        envelope.gain.setValueAtTime(envelope.gain.value, now);
        envelope.gain.linearRampToValueAtTime(0, stopAt);

        const ghost: LingeringNode = { source, envelope };
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

  const stopStretchSource = ({ fade = false }: { fade?: boolean } = {}) => {
    if (!stretchActive || !stretchNode) {
      return;
    }
    stretchActive = false;
    const node = stretchNode;
    const envelope = stretchEnvelope;

    // Unlike the native engine, the stretch node is a single node reused across starts (see
    // `startStretchSource`) — there is nothing to disconnect-and-swap here, just quiet it down.
    if (fade && audioContext && envelope) {
      const now = audioContext.currentTime;
      const stopAt = now + DECLICK_FADE_SECONDS;
      try {
        envelope.gain.cancelScheduledValues(now);
        envelope.gain.setValueAtTime(envelope.gain.value, now);
        envelope.gain.linearRampToValueAtTime(0, stopAt);
        void node.stop(stopAt);
        return;
      } catch {
        // Fall through to a hard stop.
      }
    }

    void node.stop();
  };

  const stopSource = (options: { fade?: boolean } = {}) => {
    stopNativeSource(options);
    stopStretchSource(options);
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

  /** Copies an AudioBuffer's channels into the stretch node, skipping a reload of the same buffer. */
  const loadStretchBuffer = (node: StretchNode, buffer: AudioBuffer) => {
    if (stretchLoadedBuffer === buffer) {
      return;
    }
    void node.dropBuffers();
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel).slice());
    }
    void node.addBuffers(channels);
    stretchLoadedBuffer = buffer;
  };

  const startNativeSource = () => {
    const context = getAudioContext();
    if (!context || !gainNode || !activeBuffer || !canPlayRequestedTime()) {
      return;
    }

    const offsetSeconds = getTargetOffsetSeconds();
    if (offsetSeconds >= activeBuffer.duration) {
      return;
    }

    stopSource({ fade: true });

    const source = context.createBufferSource();
    source.buffer = activeBuffer;
    // Off-speed native playback is only the transient fallback before the stretch node loads;
    // it resamples (pitch rises with tempo) until the upgrade in `ensureStretchNode` swaps it out.
    source.playbackRate.value = playbackRate;

    // Per-source envelope so this source can fade in while a previous one fades out — turning an
    // otherwise-clicky seek/restart into a short crossfade. Master volume stays on `gainNode`.
    const envelope = context.createGain();
    const fadeStartTime = context.currentTime;
    envelope.gain.setValueAtTime(0, fadeStartTime);
    envelope.gain.linearRampToValueAtTime(1, fadeStartTime + DECLICK_FADE_SECONDS);

    source.connect(envelope);
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

  /**
   * Starts (or repositions) playback on the stretch engine. Unlike the native engine — a fresh
   * `AudioBufferSourceNode` per start, crossfaded against the previous one — Stretch is a single
   * node reused for the actor's lifetime (its own internal buffering makes a fresh node per seek
   * wasteful). So there is no second node to crossfade against: the declick here is a duck (ramp
   * the one persistent envelope down, reposition, ramp back up) rather than a crossfade, and the
   * node/envelope connection is made once and left in place.
   */
  const startStretchSource = (): boolean => {
    const context = getAudioContext();
    if (!context || !gainNode || !activeBuffer || !stretchNode || !canPlayRequestedTime()) {
      return false;
    }

    const offsetSeconds = getTargetOffsetSeconds();
    if (offsetSeconds >= activeBuffer.duration) {
      return false;
    }

    // Only the native fallback needs stopping here — it's a different node/graph. Stretch's own
    // previous position (if any) is repositioned in place below, not torn down.
    stopNativeSource({ fade: true });

    const node = stretchNode;
    loadStretchBuffer(node, activeBuffer);

    const wasActive = stretchActive;
    if (!stretchEnvelope) {
      stretchEnvelope = context.createGain();
      stretchEnvelope.connect(gainNode);
    }
    if (!stretchConnected) {
      node.connect(stretchEnvelope);
      stretchConnected = true;
    }

    const envelope = stretchEnvelope;
    const now = context.currentTime;
    envelope.gain.cancelScheduledValues(now);
    if (wasActive) {
      // Already playing: duck-and-recover around the reposition/retempo point to mask the
      // input discontinuity, since there's only one continuous output to mask it on.
      envelope.gain.setValueAtTime(envelope.gain.value, now);
      envelope.gain.linearRampToValueAtTime(0, now + DECLICK_FADE_SECONDS);
      envelope.gain.linearRampToValueAtTime(1, now + DECLICK_FADE_SECONDS * 2);
    } else {
      // First activation (or resuming after a full stop): simple fade-in.
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + DECLICK_FADE_SECONDS);
    }

    void node.schedule({
      active: true,
      input: offsetSeconds,
      output: now,
      rate: playbackRate,
      semitones: 0,
    });

    playStartedAtTimelineMs = targetTimeMs;
    playStartedAtContextTime = now;
    stretchActive = true;
    return true;
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

    // Kill ghost fades from previous seeks before starting the new one, so overlapping
    // fade-outs can't accumulate into an audible echo/chorus.
    killLingeringNodes();

    if (playbackRate !== 1 && canUseStretch()) {
      if (stretchReady && stretchNode) {
        startStretchSource();
        return;
      }
      // Node still loading: play native (resampled) now and upgrade to stretch when ready.
      ensureStretchNode(context);
    }

    startNativeSource();
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

    if (!isPlaying()) {
      startSource();
    }
  };

  const applyTargetTime = (force = false) => {
    if (!isPlaying()) {
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

    // Crossing the 1x boundary switches engines (native <-> stretch), so rebuild from the
    // current position. Otherwise keep playing and just retempo in place.
    const crossesBypassBoundary = (prevRate === 1) !== (nextRate === 1);

    if (isPlaying() && crossesBypassBoundary) {
      targetTimeMs = getSourceTimelineTime();
      playbackRate = nextRate;
      startSource();
      return;
    }

    // Re-anchor the timeline clock to the current position before changing the rate.
    const currentTimelineMs = isPlaying() ? getSourceTimelineTime() : targetTimeMs;
    playbackRate = nextRate;

    if (sourceNode) {
      // Native fallback (off-speed before the stretch node loaded): keep resampling at the new rate.
      playStartedAtTimelineMs = currentTimelineMs;
      playStartedAtContextTime = audioContext?.currentTime ?? 0;
      sourceNode.playbackRate.value = nextRate;
    } else if (stretchActive && stretchNode && audioContext) {
      // Retempo the stretch node in place from the current input position — gap-free, pitch intact.
      const inputSeconds = Math.max(0, currentTimelineMs - startOffsetMs) / 1000;
      playStartedAtTimelineMs = currentTimelineMs;
      playStartedAtContextTime = audioContext.currentTime;
      void stretchNode.schedule({
        active: true,
        input: inputSeconds,
        output: audioContext.currentTime,
        rate: nextRate,
        semitones: 0,
      });
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

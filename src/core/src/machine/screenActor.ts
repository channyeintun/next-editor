import { fromCallback } from "xstate";
import { getSupportedVideoMimeType, SCREEN_VIDEO_MIME_TYPES } from "../utils/videoMimeType";
import { fixWebmDuration } from "../utils/webmDuration";

const SCREEN_TIMESLICE_MS = 1000;

// This is the keep-forever local file, so budget generously (unlike the session's telephony-grade
// audio). VP9 screencast at 1080p is transparent at ~2.5 Mbps for low-motion text content.
const SCREEN_VIDEO_BITS_PER_SECOND = 2_500_000;
const SCREEN_AUDIO_BITS_PER_SECOND = 128_000;

export interface ScreenRecordingInput {
  /**
   * Display capture stream from `getDisplayMedia`. The actor OWNS this stream: on teardown it
   * stops every track (video and any tab-audio). Callers that need a track to survive the actor
   * (e.g. the session microphone) must pass a *clone*, not the live track — see `micTrack`.
   */
  stream: MediaStream;
  /**
   * Optional cloned microphone audio track to mux into the video so the file is standalone.
   * Must be a clone: the actor stops it on teardown, and stopping the original would kill the
   * session's own microphone recorder. Absent in external-audio mode (no mic recorder to clone).
   */
  micTrack?: MediaStreamTrack | null;
  /** Injectable AudioContext constructor so jsdom tests can supply a fake. */
  audioContextCtor?: typeof AudioContext;
  /** Monotonic origin of the editor recording this local capture accompanies. */
  sessionStartedAtPerf: number;
}

export type ScreenRecordingEvent = { type: "START" } | { type: "STOP" };

export type ScreenRecordingEmit =
  | {
      type: "SCREEN_STARTED";
      actorId: string;
      mimeType: string;
      startedAtMs: number;
      startedAtPerf: number;
    }
  | {
      type: "SCREEN_STOPPED";
      actorId: string;
      blob: Blob;
      mimeType: string;
      startOffsetMs: number;
    }
  | { type: "SCREEN_ERROR"; actorId: string; error: string };

export interface ScreenCaptureMixResult {
  /** Combined stream: the display video track plus (when any audio source exists) one mixed audio track. */
  stream: MediaStream;
  /** The AudioContext that owns the mix graph, or null when there were no audio sources to mix. */
  audioContext: AudioContext | null;
}

/**
 * Build the stream handed to the screen `MediaRecorder`: the display video track, plus a single
 * mixed audio track combining every available source (tab audio from `getDisplayMedia` and/or a
 * cloned microphone track). Pure and injectable so tests can pass a fake `AudioContext`.
 *
 * With no audio sources (e.g. Firefox display capture + external-audio mode) the result is
 * video-only — still a useful artifact. The caller closes `audioContext` and stops tracks on teardown.
 */
export const buildScreenCaptureStream = (
  display: MediaStream,
  micTrack: MediaStreamTrack | null | undefined,
  options?: { audioContextCtor?: typeof AudioContext },
): ScreenCaptureMixResult => {
  const videoTrack = display.getVideoTracks()[0];
  const audioSources: MediaStreamTrack[] = [
    ...display.getAudioTracks(),
    ...(micTrack ? [micTrack] : []),
  ];

  if (audioSources.length === 0) {
    return {
      stream: new MediaStream(videoTrack ? [videoTrack] : []),
      audioContext: null,
    };
  }

  const AudioContextCtor =
    options?.audioContextCtor ??
    (window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  const audioContext = new AudioContextCtor();
  const destination = audioContext.createMediaStreamDestination();

  for (const track of audioSources) {
    // One node per track: some browsers reject a multi-track MediaStream passed to a single source.
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    source.connect(destination);
  }

  const mixedAudioTrack = destination.stream.getAudioTracks()[0];
  return {
    stream: new MediaStream(
      [videoTrack, mixedAudioTrack].filter((track): track is MediaStreamTrack => Boolean(track)),
    ),
    audioContext,
  };
};

/**
 * Screen recording actor — mirrors `cameraRecordingActor`'s lifecycle shape but records a
 * pre-acquired display stream (never self-acquires; `getDisplayMedia` must run in the click
 * handler to keep transient user activation) and muxes narration audio into a standalone video.
 *
 * The blob is emitted via `SCREEN_STOPPED` and saved to disk by the app layer — it is never
 * folded into the `Recording`, so nothing in the machine's finalize join waits on it.
 */
export const screenRecordingActor = fromCallback<
  ScreenRecordingEvent,
  ScreenRecordingInput,
  ScreenRecordingEmit
>(({ sendBack, receive, input, self }) => {
  let mediaRecorder: MediaRecorder | null = null;
  let audioContext: AudioContext | null = null;
  let chunks: Blob[] = [];
  let mimeType = "";
  let hasAudio = false;
  let disposed = false;
  let started = false;
  let failed = false;
  let startedAtMs = 0;
  let startedAtPerfMs = 0;

  const stopTrack = (track: MediaStreamTrack) => {
    try {
      track.stop();
    } catch {
      // Track may already be ended (user hit "Stop sharing"); ignore.
    }
  };

  const cleanup = () => {
    // Actor owns the input display stream and the mic clone: stop every track so the browser's
    // "sharing this tab" indicator clears and the cloned mic track is released.
    input.stream.getTracks().forEach(stopTrack);
    if (input.micTrack) {
      stopTrack(input.micTrack);
    }
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close().catch(() => {});
    }
    audioContext = null;
  };

  // The user can end the share at any time via the browser's own "Stop sharing" UI. That fires
  // "ended" on the display video track — treat it as an early but valid stop: finalize the video
  // (a shorter file) without touching the session recording, which keeps going.
  const displayVideoTrack = input.stream.getVideoTracks()[0];
  const handleTrackEnded = () => stopRecording();
  displayVideoTrack?.addEventListener("ended", handleTrackEnded);

  const startRecording = () => {
    if (started || mediaRecorder) {
      return;
    }
    started = true;

    try {
      mimeType = getSupportedVideoMimeType(SCREEN_VIDEO_MIME_TYPES);
      if (!mimeType) {
        if (!disposed) {
          sendBack({
            type: "SCREEN_ERROR",
            actorId: self.id,
            error: "No supported video MIME type found",
          });
        }
        cleanup();
        return;
      }

      const mix = buildScreenCaptureStream(input.stream, input.micTrack, {
        audioContextCtor: input.audioContextCtor,
      });
      audioContext = mix.audioContext;
      hasAudio = mix.stream.getAudioTracks().length > 0;
      if (!hasAudio) {
        // No display/tab audio and no mic to mix — the file will be silent. Surface it so a
        // consumer (e.g. the studio, which plays external narration the browser can only capture
        // as *tab* audio) does not promise "narration included" for a video that has none.
        console.warn(
          "screenRecordingActor: no audio track captured — the screen recording will be silent " +
            '(share a browser tab with "share tab audio" enabled to include the narration).',
        );
      }

      mediaRecorder = new MediaRecorder(mix.stream, {
        mimeType,
        videoBitsPerSecond: SCREEN_VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: SCREEN_AUDIO_BITS_PER_SECOND,
      });

      chunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (disposed || failed) {
          cleanup();
          return;
        }

        const rawBlob = new Blob(chunks, { type: mimeType });
        // MediaRecorder WebM has no Duration header (Chromium issue 642012), so players can't build a
        // seek bar. Inject the measured wall-clock length before handing the file off. MP4 already
        // carries a duration; a non-WebM/failed patch falls back to the raw blob (see fixWebmDuration).
        const durationMs =
          startedAtPerfMs > 0 ? Math.max(0, performance.now() - startedAtPerfMs) : 0;
        const finalize = mimeType.startsWith("video/webm")
          ? fixWebmDuration(rawBlob, durationMs)
          : Promise.resolve(rawBlob);
        const startOffsetMs =
          startedAtPerfMs > 0 && Number.isFinite(input.sessionStartedAtPerf)
            ? Math.max(0, startedAtPerfMs - input.sessionStartedAtPerf)
            : 0;

        // Duration repair can read a large blob. Release the browser capture
        // indicator and audio graph before awaiting it; the actor no longer
        // needs any live media resources after MediaRecorder has stopped.
        cleanup();
        finalize.then((blob) => {
          if (!disposed) {
            sendBack({
              type: "SCREEN_STOPPED",
              actorId: self.id,
              blob,
              mimeType,
              hasAudio,
              startOffsetMs,
            });
          }
        });
      };

      mediaRecorder.onstart = () => {
        if (!disposed && !failed) {
          startedAtMs = Date.now();
          startedAtPerfMs = performance.now();
          sendBack({
            type: "SCREEN_STARTED",
            actorId: self.id,
            mimeType,
            hasAudio,
            startedAtMs,
            startedAtPerf: startedAtPerfMs,
          });
        }
      };

      mediaRecorder.onerror = (event: Event) => {
        if (disposed || failed) return;
        failed = true;
        const recorderError = (event as Event & { error?: unknown }).error;
        sendBack({
          type: "SCREEN_ERROR",
          actorId: self.id,
          error: recorderError instanceof Error ? recorderError.message : "Screen recording error",
        });
        cleanup();
      };

      mediaRecorder.start(SCREEN_TIMESLICE_MS);
    } catch (error) {
      if (!disposed) {
        sendBack({
          type: "SCREEN_ERROR",
          actorId: self.id,
          error: error instanceof Error ? error.message : "Failed to start screen recording",
        });
      }
      cleanup();
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
    displayVideoTrack?.removeEventListener("ended", handleTrackEnded);
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    cleanup();
  };
});

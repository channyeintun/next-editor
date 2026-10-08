import { createIdleScreenState, type EditorActionArgs, type EditorContextUpdate } from "./types";
import { normalizeNonNegativeTime } from "./playbackValues";

// ============================================================================
// Local screen-recording action bodies
//
// The screen video is a keep-forever, local-only artifact. It rides in on the
// START_RECORDING event as a pre-acquired display stream (acquired in the click
// handler to keep transient user activation) and exits via `onScreenRecordingReady`,
// its only exit (the app saves it with `saveScreenRecordingLocally`). It NEVER enters
// the `Recording`, the `.ne` codec, storage or any upload path; the editorMachine.test.ts
// guardrail ("the finalized recording carries no screen fields") enforces it, and
// "Screen recording actor" in docs/state-machines.md describes the actor. Nothing here
// writes a `screen*` field onto the finalized recording.
// ============================================================================

const SCREEN_RECORDER_ID_PREFIX = "screenRecorder-";

export const setScreenStream = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "START_RECORDING") return {};
  const screenStream = event.screenStream ?? null;
  const screenRecorderGeneration = screenStream
    ? context.screenRecorderGeneration + 1
    : context.screenRecorderGeneration;
  return {
    screenStream,
    screenRecorderGeneration,
    screen: screenStream
      ? {
          ...createIdleScreenState(),
          actorId: `${SCREEN_RECORDER_ID_PREFIX}${screenRecorderGeneration}`,
        }
      : createIdleScreenState(),
  };
};

export const storeScreenStarted = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "SCREEN_STARTED") return {};
  return {
    screen: {
      ...context.screen,
      mimeType: event.mimeType,
      hasAudio: event.hasAudio,
    },
  };
};

export const notifyScreenRecordingReady = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "SCREEN_STOPPED") return;
  context.onScreenRecordingReady?.({
    blob: event.blob,
    mimeType: event.mimeType || event.blob.type,
    hasAudio: event.hasAudio,
    startOffsetMs: normalizeNonNegativeTime(event.startOffsetMs),
  });
};

/** Reset screen slices after the blob has exited. The actor releases tracks before emitting it. */
export const clearScreenRecording = (): EditorContextUpdate => ({
  screen: createIdleScreenState(),
  screenStream: null,
});

export const handleScreenError = ({ event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "SCREEN_ERROR") return {};
  console.warn("Screen recording disabled:", event.error);
  return clearScreenRecording();
};

/**
 * Stop and drop a pre-acquired display stream that never reached the actor. Used only on the
 * arming-gap abort paths (mic AUDIO_RECORDING_ERROR / early STOP_RECORDING before the screen actor
 * spawns) —
 * once the actor owns the stream, its own teardown handles track cleanup instead.
 */
export const releaseScreenStream = ({ context }: EditorActionArgs): EditorContextUpdate => {
  if (!context.screenStream) return {};
  context.screenStream.getTracks().forEach((track) => track.stop());
  return clearScreenRecording();
};

/**
 * Stop the display stream of a START_RECORDING that no state accepted: the codec refusal in idle,
 * or any state other than idle (the record button stays live while the mic prompt is open and
 * during the stop window). The host ran getDisplayMedia at click time and handed the stream over,
 * so nothing else will ever stop those tracks. Plain side effect: it must not touch the screen
 * context of a capture that is still running or finishing.
 */
export const releaseUnacceptedScreenStream = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "START_RECORDING" || !event.screenStream) return;
  // A host re-sending the stream the machine already owns must not kill the live capture.
  if (event.screenStream === context.screenStream) return;
  event.screenStream.getTracks().forEach((track) => track.stop());
};

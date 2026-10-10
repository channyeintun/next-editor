import type { EditorActionArgs, EditorMachineContext } from "./types";
import type { AudioPlaybackEvent } from "./audioActor";
import type { RecorderControlEvent } from "./recorderControl";

// ============================================================================
// Running recorders
//
// Which of a take's recorders are running (getRunningRecorders), the one fan-out
// that messages them (sendToRunningRecorders), and the action bodies that pause,
// resume and stop them. editorMachine.ts wraps each body as `enqueueActions(fn)`
// under the same name, so `setup()` still infers the machine's exact types.
// ============================================================================

/** The recorders a take is running now. A paused one is still running. */
export interface RunningRecorders {
  /** The microphone recorder, `audioRecorder`. */
  microphone: boolean;
  /** A selected narration file, played in step with the take by `recordingAudioPlayer`. */
  externalAudio: boolean;
  /** The camera recorder, `cameraRecorder`. */
  camera: boolean;
  /** The screen recorder's child id, or null when none is running. */
  screenActorId: string | null;
}

/** The one answer to "which recorders are running", for the machine's sends and guards. */
export const getRunningRecorders = (context: EditorMachineContext): RunningRecorders => ({
  microphone: context.audio.isRecording && context.audio.source === "microphone",
  externalAudio: context.audio.isRecording && context.audio.source === "external",
  camera: context.enableCameraRecording && context.camera.isRecording,
  screenActorId: context.screen.isRecording ? context.screen.actorId : null,
});

/**
 * The subset of xstate's `enqueue` object the recorder sends use. Kept structural (as
 * PlaybackActorsEnqueue is in playbackActors.ts) so these bodies don't need to thread
 * the machine's full setup() type parameters. The screen recorder's id is per capture.
 */
export interface RecorderSendEnqueue {
  sendTo: ((actor: "audioRecorder", event: RecorderControlEvent) => void) &
    ((actor: "recordingAudioPlayer", event: AudioPlaybackEvent) => void) &
    ((actor: "cameraRecorder", event: RecorderControlEvent) => void) &
    ((actor: string, event: RecorderControlEvent) => void);
}

/** What each recorder is sent; a recorder left out is sent nothing. */
export interface RecorderSends {
  microphone?: RecorderControlEvent;
  /** The narration file's player takes playback events, sent in list order. */
  externalAudio?: AudioPlaybackEvent | readonly AudioPlaybackEvent[];
  camera?: RecorderControlEvent;
  screen?: RecorderControlEvent;
}

/**
 * Sends each running recorder its event, always in the order microphone, narration
 * file, camera, screen. A recorder that is not running is sent nothing.
 */
export function sendToRunningRecorders(
  running: RunningRecorders,
  enqueue: RecorderSendEnqueue,
  sends: RecorderSends,
): void {
  if (running.microphone && sends.microphone) {
    enqueue.sendTo("audioRecorder", sends.microphone);
  }
  if (running.externalAudio && sends.externalAudio) {
    const events: readonly AudioPlaybackEvent[] = Array.isArray(sends.externalAudio)
      ? sends.externalAudio
      : [sends.externalAudio];
    for (const event of events) enqueue.sendTo("recordingAudioPlayer", event);
  }
  if (running.camera && sends.camera) {
    enqueue.sendTo("cameraRecorder", sends.camera);
  }
  if (running.screenActorId && sends.screen) {
    enqueue.sendTo(running.screenActorId, sends.screen);
  }
}

/**
 * The recorders follow the take's clock: each writes nothing while it is paused, so
 * the narration, camera and screen files skip the same spans the timeline does. A
 * selected narration file is an input, not a recording, so it pauses in place. A
 * retake holds every recorder with these same sends.
 */
export const PAUSE_RECORDER_SENDS: RecorderSends = {
  microphone: { type: "PAUSE" },
  externalAudio: { type: "PAUSE" },
  camera: { type: "PAUSE" },
  screen: { type: "PAUSE" },
};

type RecorderSendArgs = EditorActionArgs & { enqueue: RecorderSendEnqueue };

export const pauseRecordingMedia = ({ context, enqueue }: RecorderSendArgs): void => {
  sendToRunningRecorders(getRunningRecorders(context), enqueue, PAUSE_RECORDER_SENDS);
};

export const resumeRecordingMedia = ({ context, enqueue }: RecorderSendArgs): void => {
  sendToRunningRecorders(getRunningRecorders(context), enqueue, {
    microphone: { type: "RESUME" },
    externalAudio: { type: "PLAY" },
    camera: { type: "RESUME" },
    screen: { type: "RESUME" },
  });
};

/** Asks the microphone and camera for their files; stoppingRecording waits for them. */
export const stopRecordingMedia = ({ context, enqueue }: RecorderSendArgs): void => {
  sendToRunningRecorders(getRunningRecorders(context), enqueue, {
    microphone: { type: "STOP" },
    camera: { type: "STOP" },
  });
};

/**
 * Every exit from `recording` ends the session (→ stoppingRecording / loading / idle), so
 * this single action stops the screen recorder on all of them — including the external-audio
 * and no-audio paths that bypass `stoppingRecording`. The actor's STOP → onstop → root
 * SCREEN_STOPPED handler then saves the blob (which can land after we've reached playback).
 * Skipped when the user already ended the share early (isRecording cleared on SCREEN_STOPPED).
 */
export const stopScreenRecording = ({ context, enqueue }: RecorderSendArgs): void => {
  sendToRunningRecorders(getRunningRecorders(context), enqueue, { screen: { type: "STOP" } });
};

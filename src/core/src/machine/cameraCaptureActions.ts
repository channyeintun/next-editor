import type { RecordingCameraSource } from "../types";
import type { EditorActionArgs, EditorContextUpdate, EditorMachineContext } from "./types";
import type { CameraRecordingInput } from "./cameraActor";
import type { RecorderControlEvent } from "./recorderControl";
import { getRecorderStartOffsetMs } from "./recordingSession";

// ============================================================================
// Camera capture action bodies
//
// The take's camera slice: the instructor-face recorder ("cameraRecorder"). What
// the slice holds (CameraState), whether the take records the camera, starting
// the recorder, storing what it sends, and dropping the slice when it fails.
// editorMachine.ts wraps each body as `assign(fn)` / `enqueueActions(fn)` under the
// same name, so `setup()` still infers the machine's exact types. Imports from
// ./types are type-only: types.ts takes the slice and its idle factory from here.
// ============================================================================

/**
 * Camera state for instructor-face recording
 */
export interface CameraState {
  /** Camera blob from recording */
  blob: Blob | null;
  /** Whether camera recording is active */
  isRecording: boolean;
  /** Detected MIME type */
  mimeType: string;
  /** The running camera MediaRecorder, for hosts that journal its chunks. */
  mediaRecorder: MediaRecorder | null;
  /** Source used for the active or finalized camera video */
  source: RecordingCameraSource | null;
  /**
   * Recorded time at which the camera actually started capturing: its start read from
   * `session.startedAtPerf` through the take's clock (`getRecorderStartOffsetMs`). The camera
   * spawns after `getUserMedia` resolves, so its first frame lags the timeline origin by this
   * warmup; playback subtracts it to stay in sync.
   */
  startOffsetMs: number;
}

/** The idle camera slice. A factory, so no two contexts or takes alias one slice. */
export const createIdleCameraState = (): CameraState => ({
  blob: null,
  isRecording: false,
  mimeType: "",
  mediaRecorder: null,
  source: null,
  startOffsetMs: 0,
});

export const setCameraRecordingEnabled = ({
  context,
  event,
}: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "START_RECORDING") return {};
  // The choice is per take. Falling back to the previous take's value let one manual
  // camera take turn the camera on for every later start that does not say, such as a
  // studio render on the same page.
  return {
    enableCameraRecording: event.enableCamera ?? context.defaultEnableCameraRecording,
  };
};

/**
 * The subset of xstate's `enqueue` object the camera recorder's start uses. Kept
 * structural, like the microphone's, so this body doesn't need to thread the machine's
 * full setup() type parameters.
 */
interface CameraRecorderEnqueue {
  spawnChild: (
    src: "cameraRecording",
    options: { id: "cameraRecorder"; input: CameraRecordingInput },
  ) => void;
  sendTo: (actor: "cameraRecorder", event: RecorderControlEvent) => void;
  assign: (updater: Partial<EditorMachineContext>) => void;
}

export const startCameraRecorder = ({
  context,
  enqueue,
}: EditorActionArgs & { enqueue: CameraRecorderEnqueue }): void => {
  if (!context.enableCameraRecording) return;

  // Spawn, not invoke: conditional on enableCameraRecording.
  enqueue.spawnChild("cameraRecording", {
    id: "cameraRecorder",
    input: {},
  });
  enqueue.sendTo("cameraRecorder", { type: "START" });
  enqueue.assign({
    camera: { ...createIdleCameraState(), isRecording: true, source: "camera" as const },
  });
};

export const storeCameraStarted = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "CAMERA_STARTED") return {};
  // The camera MediaRecorder only starts after getUserMedia resolves, which lags the
  // recording-session origin (session.startedAtPerf) by the camera warmup. Capture that
  // offset so playback can shift the video back into sync; otherwise the face video runs
  // ahead of audio. Both sides must be the same (monotonic) clock: performance.now(), the
  // clock session.startedAtPerf was read from. Read through the take's clock: a camera
  // that finished warming up during a pause starts recording when the take resumes,
  // which is the moment the pause holds.
  const startOffsetMs = getRecorderStartOffsetMs(context.session, event.startedAtPerf);
  return {
    camera: {
      ...context.camera,
      mimeType: event.mimeType,
      mediaRecorder: event.mediaRecorder,
      startOffsetMs,
    },
  };
};

export const storeCameraBlob = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "CAMERA_STOPPED") return {};
  return {
    camera: {
      ...context.camera,
      blob: event.blob,
      isRecording: false,
      mediaRecorder: null,
      mimeType: event.blob.type,
      source: "camera" as const,
    },
  };
};

export const clearCameraRecording = (): EditorContextUpdate => ({
  camera: createIdleCameraState(),
});

export const handleCameraError = ({ event }: EditorActionArgs): EditorContextUpdate => {
  if (event.type !== "CAMERA_ERROR") return {};
  console.warn("Camera recording disabled:", event.error);
  return clearCameraRecording();
};

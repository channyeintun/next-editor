import { fromTypedCallback } from "./fromTypedCallback";
import {
  RECORDER_TIMESLICE_MS,
  recorderErrorMessage,
  stopRecorderIfActive,
  syncRecorderPause,
  type RecorderControlEvent,
} from "./recorderControl";
import { getSupportedRecorderMimeType, CAMERA_VIDEO_MIME_TYPES } from "../utils/recorderMimeType";

// The face camera records a small square tile (480x480 at 24fps by default), so ~400 kbps
// keeps the file light.
const CAMERA_VIDEO_BITS_PER_SECOND = 400_000;
const DEFAULT_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 480 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
};

export interface CameraRecordingInput {
  constraints?: MediaTrackConstraints;
}

/** What the machine sends the camera recorder. */
export type CameraRecordingEvent = RecorderControlEvent;

export type CameraRecordingEmit =
  | {
      type: "CAMERA_STARTED";
      mimeType: string;
      startedAtPerf: number;
      /** The running recorder, so the host can journal its chunks as they arrive. */
      mediaRecorder: MediaRecorder;
    }
  | { type: "CAMERA_STOPPED"; blob: Blob }
  | { type: "CAMERA_ERROR"; error: string };

export const cameraRecordingActor = fromTypedCallback<
  CameraRecordingEvent,
  CameraRecordingInput,
  CameraRecordingEmit
>(({ sendBack, receive, input }) => {
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let mimeType = "";
  let disposed = false;
  let starting = false;
  let stopRequested = false;
  let failed = false;
  let startedAtPerfMs = 0;
  // The take's pause state. The camera warms up after the take starts, so a pause
  // can arrive before its recorder exists; it is applied once the recorder starts.
  // A paused MediaRecorder writes no frames, so the video skips the take's pauses
  // the way its recorded time does.
  let paused = false;

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
        video: input.constraints ?? DEFAULT_CAMERA_CONSTRAINTS,
        audio: false,
      });

      if (disposed || stopRequested) {
        cleanupStream();
        return;
      }

      mimeType = getSupportedRecorderMimeType(CAMERA_VIDEO_MIME_TYPES);
      if (!mimeType) {
        cleanupStream();
        if (!disposed) {
          failed = true;
          sendBack({ type: "CAMERA_ERROR", error: "No supported video MIME type found" });
        }
        return;
      }

      mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: CAMERA_VIDEO_BITS_PER_SECOND,
      });

      chunks = [];

      // Accumulate chunks only to assemble the final blob on stop. Camera video is stored as a
      // separate file/blob (never inline in the SCR3 stream), so no per-chunk events are emitted.
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        if (!disposed && !failed) {
          sendBack({ type: "CAMERA_STOPPED", blob });
        }

        cleanupStream();
      };

      mediaRecorder.onstart = () => {
        if (!disposed && !stopRequested && mediaRecorder) {
          startedAtPerfMs = performance.now();
          sendBack({
            type: "CAMERA_STARTED",
            mimeType,
            startedAtPerf: startedAtPerfMs,
            mediaRecorder,
          });
          syncRecorderPause(mediaRecorder, paused);
        }
      };

      mediaRecorder.onerror = (event: Event) => {
        if (disposed || stopRequested) return;
        failed = true;
        stopRequested = true;
        sendBack({
          type: "CAMERA_ERROR",
          error: recorderErrorMessage(event, "Camera recording error"),
        });
        stopRecorderIfActive(mediaRecorder);
        cleanupStream();
      };

      mediaRecorder.start(RECORDER_TIMESLICE_MS);
    } catch (error) {
      cleanupStream();
      if (!disposed && !stopRequested) {
        failed = true;
        sendBack({
          type: "CAMERA_ERROR",
          error: error instanceof Error ? error.message : "Failed to start camera recording",
        });
      }
    } finally {
      starting = false;
    }
  };

  const stopRecording = () => {
    stopRequested = true;
    if (mediaRecorder) {
      stopRecorderIfActive(mediaRecorder);
      return;
    }
    // STOP while getUserMedia is still pending (warm-up or an open permission prompt): no
    // recorder will ever fire onstop, so report once now or stoppingRecording waits out its 2s
    // watchdog. A stream that resolves later is released by startRecording's stopRequested check.
    if (!failed && !disposed) {
      failed = true;
      sendBack({ type: "CAMERA_ERROR", error: "Camera stopped before recording started" });
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
      case "PAUSE":
        paused = true;
        syncRecorderPause(mediaRecorder, paused);
        break;
      case "RESUME":
        paused = false;
        syncRecorderPause(mediaRecorder, paused);
        break;
    }
  });

  return () => {
    disposed = true;
    stopRecorderIfActive(mediaRecorder);
    cleanupStream();
  };
});

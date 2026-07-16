import { fromCallback } from "xstate";
import { getSupportedVideoMimeType, CAMERA_VIDEO_MIME_TYPES } from "../utils/videoMimeType";

const CAMERA_TIMESLICE_MS = 1000;

export interface CameraRecordingInput {
  constraints?: MediaTrackConstraints;
}

export type CameraRecordingEvent = { type: "START" } | { type: "STOP" };

export type CameraRecordingEmit =
  | { type: "CAMERA_STARTED"; mimeType: string; startedAtMs: number; startedAtPerf: number }
  | { type: "CAMERA_STOPPED"; blob: Blob }
  | { type: "CAMERA_ERROR"; error: string };

export const cameraRecordingActor = fromCallback<
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
  let startedAtMs = 0;
  let startedAtPerfMs = 0;

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
        video: input.constraints ?? {
          width: { ideal: 480 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: "user",
        },
        audio: false,
      });

      if (disposed || stopRequested) {
        cleanupStream();
        return;
      }

      mimeType = getSupportedVideoMimeType(CAMERA_VIDEO_MIME_TYPES);
      if (!mimeType) {
        cleanupStream();
        if (!disposed) {
          sendBack({ type: "CAMERA_ERROR", error: "No supported video MIME type found" });
        }
        return;
      }

      mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 400_000,
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
        if (!disposed && !stopRequested) {
          startedAtMs = Date.now();
          startedAtPerfMs = performance.now();
          sendBack({
            type: "CAMERA_STARTED",
            mimeType,
            startedAtMs,
            startedAtPerf: startedAtPerfMs,
          });
        }
      };

      mediaRecorder.onerror = (event: Event) => {
        if (disposed || stopRequested) return;
        failed = true;
        stopRequested = true;
        const recorderError = (event as Event & { error?: unknown }).error;
        sendBack({
          type: "CAMERA_ERROR",
          error: recorderError instanceof Error ? recorderError.message : "Camera recording error",
        });
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          mediaRecorder.stop();
        }
        cleanupStream();
      };

      mediaRecorder.start(CAMERA_TIMESLICE_MS);
    } catch (error) {
      cleanupStream();
      if (!disposed && !stopRequested) {
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

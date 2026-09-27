// What the microphone, camera and screen recorder actors share: the events the machine
// sends them, following the take's pauses, and reading a recorder's error.

/**
 * What the machine sends a recorder actor. PAUSE and RESUME follow the take's clock: a
 * paused MediaRecorder writes nothing, so its file skips the same spans the take's
 * recorded time does.
 */
export type RecorderControlEvent =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "PAUSE" }
  | { type: "RESUME" };

/**
 * Pauses or resumes `recorder` to match the take. A pause can arrive before the recorder
 * exists (it starts after the take does), so each actor calls this again once its
 * recorder starts. Returns what changed, for a recorder that keeps its own pause times.
 */
export function syncRecorderPause(
  recorder: MediaRecorder | null,
  paused: boolean,
): "paused" | "resumed" | null {
  if (!recorder) return null;
  if (paused && recorder.state === "recording") {
    recorder.pause();
    return "paused";
  }
  if (!paused && recorder.state === "paused") {
    recorder.resume();
    return "resumed";
  }
  return null;
}

/** The message a MediaRecorder `error` event carries, or `fallback` when it has none. */
export function recorderErrorMessage(event: Event, fallback: string): string {
  const error = (event as Event & { error?: unknown }).error;
  return error instanceof Error ? error.message : fallback;
}

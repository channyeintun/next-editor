import { useEffect, useRef, useState } from "react";
import type { Recording } from "../core/src";

/**
 * Detects "a live recording just finished" so a consumer (Editor.tsx) can
 * offer a post-recording action exactly once per stop.
 *
 * A take marks itself pending while isRecording is true, and the first
 * recording that appears after it ends is its result, which consumes the mark.
 * Not a plain isRecording(true)->(false) edge — stopping a mic/camera recording
 * passes through an intermediate machine state ("stoppingRecording") where
 * isRecording has already gone false but the finished Recording isn't in
 * context yet (up to ~2s later, once finalizeRecording actually runs — see
 * editorMachine.ts). A plain edge check fires-and-consumes-itself on the render
 * where currentRecording is still null, permanently missing the later render
 * where it appears. Consuming the mark keeps a lesson opened later (a dropped
 * file, the header import, a new ?url=) from being offered as the take.
 */
export function usePostRecordingTarget(isRecording: boolean, currentRecording: Recording | null) {
  const takePendingRef = useRef(false);
  const [target, setTarget] = useState<Recording | null>(null);

  useEffect(() => {
    if (isRecording) {
      takePendingRef.current = true;
    }
  }, [isRecording]);

  useEffect(() => {
    if (takePendingRef.current && !isRecording && currentRecording) {
      takePendingRef.current = false;
      setTarget(currentRecording);
    }
  }, [isRecording, currentRecording]);

  return { target, clear: () => setTarget(null) };
}

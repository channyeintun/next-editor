import { useEffect, useRef, useState } from "react";
import type { Recording } from "../core/src";

/**
 * Detects "a live recording just finished" so a consumer (Editor.tsx) can
 * offer a post-recording action exactly once per stop.
 *
 * Sticky "has this session ever been recording" + "already shown this exact
 * recording id", not a plain isRecording(true)->(false) edge — stopping a
 * mic/camera recording passes through an intermediate machine state
 * ("stoppingRecording") where isRecording has already gone false but the
 * finished Recording isn't in context yet (up to ~2s later, once
 * finalizeRecording actually runs — see editorMachine.ts). A plain edge
 * check fires-and-consumes-itself on the render where currentRecording is
 * still null, permanently missing the later render where it appears.
 */
export function usePostRecordingTarget(isRecording: boolean, currentRecording: Recording | null) {
  const hasRecordedRef = useRef(false);
  const shownRecordingIdRef = useRef<string | null>(null);
  const [target, setTarget] = useState<Recording | null>(null);

  useEffect(() => {
    if (isRecording) {
      hasRecordedRef.current = true;
    }
  }, [isRecording]);

  useEffect(() => {
    if (
      hasRecordedRef.current &&
      !isRecording &&
      currentRecording &&
      shownRecordingIdRef.current !== currentRecording.id
    ) {
      shownRecordingIdRef.current = currentRecording.id;
      setTarget(currentRecording);
    }
  }, [isRecording, currentRecording]);

  return { target, clear: () => setTarget(null) };
}

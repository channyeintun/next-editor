import { useEffect, useRef } from "react";
import type { Recording } from "../core/src";
import { parseTimeParameter } from "../core/src/utils/chapters";

/**
 * A link to a moment (`?t=90`, `?t=1m30s`, `?t=1:30`) opens the lesson there, once for
 * each recording it loads. Returns a getter for where that recording was opened, so
 * autoplay can tell a lesson still at its opening moment from one the viewer moved.
 */
export function useLinkedStartTime(
  recording: Recording | null,
  timeParameter: string | null,
  seekTo: (time: number) => void,
): (recordingId: string) => number {
  const startRef = useRef<{ recordingId: string; time: number } | null>(null);

  useEffect(() => {
    if (!recording || startRef.current?.recordingId === recording.id) return;
    const target = parseTimeParameter(timeParameter);
    const time = target === null ? 0 : Math.min(target, recording.duration);
    startRef.current = { recordingId: recording.id, time };
    if (time > 0) seekTo(time);
  }, [recording, timeParameter, seekTo]);

  return (recordingId) =>
    startRef.current?.recordingId === recordingId ? startRef.current.time : 0;
}

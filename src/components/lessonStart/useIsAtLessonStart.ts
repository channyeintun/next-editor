import { useSearchParams } from "react-router";
import { useLiveTimeValue, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { parseTimeParameter } from "../../core/src/utils/chapters";

/**
 * Whether the loaded lesson stands at its start: 0:00, or the moment a link (?t=) opened
 * it at, which is its start as far as its play button is concerned. Whether, not when:
 * the caller re-renders as the playhead leaves the start, not on every tick.
 */
export function useIsAtLessonStart(): boolean {
  const duration = useNextEditorMetadata((metadata) => metadata.currentRecording?.duration);
  const [searchParams] = useSearchParams();
  const linkStart =
    duration === undefined ? 0 : Math.min(parseTimeParameter(searchParams.get("t")) ?? 0, duration);
  return useLiveTimeValue(
    (currentTime) => currentTime === 0 || Math.abs(currentTime - linkStart) < 1,
  );
}

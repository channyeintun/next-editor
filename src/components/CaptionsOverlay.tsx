import { useNextEditorMetadata, useLiveTimeValue } from "../hooks/useNextEditorContext";
import { useCaptionStore } from "../hooks/useCaptionStore";
import { selectCaptionTrack } from "../captions/captionTracks";
import type { CaptionCue } from "../core/src/types";

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

function findActiveCue(cues: CaptionCue[], time: number): CaptionCue | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid];
    if (time < cue.start) {
      hi = mid - 1;
    } else if (time >= cue.end) {
      lo = mid + 1;
    } else {
      return cue;
    }
  }
  return null;
}

const CaptionsOverlay: React.FC = () => {
  const { currentRecording } = useNextEditorMetadata();
  const { enabled, trackId, language } = useCaptionStore();

  const activeTrack = selectCaptionTrack(currentRecording?.captions, { trackId, language });
  // The cue, not the time: the overlay re-renders when the caption changes, not every tick.
  const activeCue = useLiveTimeValue((time) =>
    enabled && activeTrack ? findActiveCue(activeTrack.cues, time) : null,
  );

  if (!enabled || !activeTrack || !activeCue) return null;

  const isRtl = RTL_LANGUAGES.has(activeTrack.language.split("-")[0]);

  return (
    <div className="absolute bottom-32 z-101 flex justify-center pointer-events-none px-4 inset-x-0">
      <div
        // So screen readers voice, and the browser picks fonts for, the captions' language.
        lang={activeTrack.language || undefined}
        dir={isRtl ? "rtl" : undefined}
        className="max-w-[78ch] rounded-xl bg-[lch(4.83_5.58_267.3/0.15)] px-4.5 py-2.25 text-center text-[24px] leading-8.5 font-medium text-white [text-shadow:0_1px_4px_#000] backdrop-blur-sm sm:text-[18px] sm:leading-6.5 sm:px-3.5"
      >
        {activeCue.text}
      </div>
    </div>
  );
};

export default CaptionsOverlay;

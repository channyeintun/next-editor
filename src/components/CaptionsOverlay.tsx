import { useMemo } from "react";
import { useNextEditorMetadata, useLiveTime } from "../hooks/useNextEditorContext";
import { useCaptionStore } from "../hooks/useCaptionStore";
import type { CaptionCue, CaptionTrack } from "../core/src/types";

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

function selectTrack(
  tracks: CaptionTrack[],
  preferredLanguage: string | null,
): CaptionTrack | null {
  if (tracks.length === 0) return null;
  if (preferredLanguage) {
    const match = tracks.find((t) => t.language === preferredLanguage);
    if (match) return match;
  }
  const defaultTrack = tracks.find((t) => t.default);
  return defaultTrack ?? tracks[0];
}

const CaptionsOverlay: React.FC = () => {
  const { currentRecording } = useNextEditorMetadata();
  const { enabled, language } = useCaptionStore();
  const currentTime = useLiveTime();

  const tracks = currentRecording?.captions;
  const activeTrack = useMemo(
    () => (tracks && tracks.length > 0 ? selectTrack(tracks, language) : null),
    [tracks, language],
  );

  if (!enabled || !activeTrack) return null;

  const activeCue = findActiveCue(activeTrack.cues, currentTime);
  if (!activeCue) return null;

  const isRtl = RTL_LANGUAGES.has(activeTrack.language.split("-")[0]);

  return (
    <div className="absolute bottom-16 left-0 right-0 z-40 flex justify-center pointer-events-none px-4">
      <div
        dir={isRtl ? "rtl" : undefined}
        className="max-w-[78ch] rounded-lg border border-white/12 bg-[#071017e0] px-4.5 py-2.25 text-center text-[24px] leading-8.5 text-[#d7e3ef] shadow-[0_14px_45px_#0000004d] backdrop-blur-[10px] sm:text-[18px] sm:leading-6.5 sm:px-3.5"
      >
        {activeCue.text}
      </div>
    </div>
  );
};

export default CaptionsOverlay;

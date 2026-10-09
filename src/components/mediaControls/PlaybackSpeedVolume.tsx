import { type ChangeEvent, useId } from "react";
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from "../../core/src/machine/playbackValues";
import { useNextEditorPlayback } from "../../hooks/useNextEditorContext";
import { useApplySpeedAndVolume } from "../../hooks/usePlaybackSettings";

/** The player settings' speed and volume sliders. */
const PlaybackSpeedVolume = () => {
  const { playbackSpeed, volume } = useNextEditorPlayback();
  const { applySpeed, applyVolume } = useApplySpeedAndVolume();
  // Generated, so two players on one page never share a label's target.
  const speedId = useId();
  const volumeId = useId();

  const handleVolumeChange = (event: ChangeEvent<HTMLInputElement>) => {
    applyVolume(parseFloat(event.target.value));
  };

  const handleSpeedChange = (event: ChangeEvent<HTMLInputElement>) => {
    applySpeed(parseFloat(event.target.value));
  };

  return (
    <>
      <div className="mb-3">
        <label htmlFor={speedId} className="block text-sm font-medium text-slate-300 mb-2">
          Speed
        </label>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-300 min-w-8">{playbackSpeed}x</span>
          <input
            id={speedId}
            type="range"
            min={MIN_PLAYBACK_SPEED}
            max={MAX_PLAYBACK_SPEED}
            step="0.25"
            value={playbackSpeed}
            aria-valuetext={`${playbackSpeed}×`}
            onChange={handleSpeedChange}
            className="flex-1 h-1 bg-slate-600 rounded appearance-none cursor-pointer accent-[#10c776]"
          />
        </div>
      </div>
      <div className="mb-3">
        <label htmlFor={volumeId} className="block text-sm font-medium text-slate-300 mb-2">
          Volume
        </label>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-300 min-w-8">{Math.round(volume * 100)}</span>
          <input
            id={volumeId}
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={volume}
            aria-valuetext={`${Math.round(volume * 100)}%`}
            onChange={handleVolumeChange}
            className="flex-1 h-1 bg-slate-600 rounded appearance-none cursor-pointer accent-[#10c776]"
          />
        </div>
      </div>
    </>
  );
};

export default PlaybackSpeedVolume;

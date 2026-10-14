import { type ChangeEvent, useId } from "react";
import { Gauge, Volume2, VolumeX } from "lucide-react";
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from "../../core/src/machine/playbackValues";
import { useNextEditorPlayback } from "../../hooks/useNextEditorContext";
import { useApplySpeedAndVolume } from "../../hooks/usePlaybackSettings";
import MenuRowIcon from "./MenuRowIcon";

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

  // Each slider sits under its label, in the menu's label column.
  return (
    <>
      <div className="group/row px-2.5 py-1.5">
        <div className="flex items-center gap-2.5">
          <MenuRowIcon icon={Gauge} />
          <label htmlFor={speedId} className="flex-1 text-sm font-medium text-slate-200">
            Speed
          </label>
          <span className="text-sm text-slate-300 tabular-nums">{playbackSpeed}x</span>
        </div>
        <div className="mt-2 pl-6.5">
          <input
            id={speedId}
            type="range"
            min={MIN_PLAYBACK_SPEED}
            max={MAX_PLAYBACK_SPEED}
            step="0.25"
            value={playbackSpeed}
            aria-valuetext={`${playbackSpeed}×`}
            onChange={handleSpeedChange}
            className="block h-1 w-full bg-slate-600 rounded appearance-none cursor-pointer accent-[#10c776]"
          />
        </div>
      </div>
      <div className="group/row px-2.5 py-1.5">
        <div className="flex items-center gap-2.5">
          <MenuRowIcon icon={volume === 0 ? VolumeX : Volume2} />
          <label htmlFor={volumeId} className="flex-1 text-sm font-medium text-slate-200">
            Volume
          </label>
          <span className="text-sm text-slate-300 tabular-nums">{Math.round(volume * 100)}</span>
        </div>
        <div className="mt-2 pl-6.5">
          <input
            id={volumeId}
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={volume}
            aria-valuetext={`${Math.round(volume * 100)}%`}
            onChange={handleVolumeChange}
            className="block h-1 w-full bg-slate-600 rounded appearance-none cursor-pointer accent-[#10c776]"
          />
        </div>
      </div>
    </>
  );
};

export default PlaybackSpeedVolume;

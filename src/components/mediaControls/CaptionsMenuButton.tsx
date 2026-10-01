import type { Dispatch, SetStateAction } from "react";
import { Captions, Check } from "lucide-react";
import type { CaptionTrack } from "../../core/src/types";
import { useCaptionStore, useCaptionStoreTrigger } from "../../hooks/useCaptionStore";
import { selectCaptionTrack } from "../../captions/captionTracks";

function captionsButtonTitle(hasMultipleTracks: boolean, captionsEnabled: boolean): string {
  if (hasMultipleTracks) return "Captions";
  return captionsEnabled ? "Hide captions" : "Show captions";
}

/**
 * Turns the lesson's captions on and off or, when it has several tracks, opens a menu to
 * pick one. Whether the menu is open is the player bar's state (see MediaControls).
 */
const CaptionsMenuButton = ({
  tracks,
  menuOpen,
  setMenuOpen,
  iconSize,
  className,
}: {
  tracks: readonly CaptionTrack[];
  menuOpen: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  iconSize: number;
  className: string;
}) => {
  const { enabled: captionsEnabled, trackId, language } = useCaptionStore();
  const captionTrigger = useCaptionStoreTrigger();
  const hasMultipleTracks = tracks.length > 1;
  // By id: a studio track and a generated one can share a language.
  const activeTrackId = selectCaptionTrack(tracks, { trackId, language })?.id;

  return (
    <div className="relative pointer-events-auto">
      <button
        type="button"
        onClick={() => {
          if (hasMultipleTracks) {
            setMenuOpen((prev) => !prev);
          } else {
            captionTrigger.toggleEnabled();
          }
        }}
        {...(hasMultipleTracks
          ? { "aria-haspopup": "menu" as const, "aria-expanded": menuOpen }
          : { "aria-pressed": captionsEnabled })}
        title={captionsButtonTitle(hasMultipleTracks, captionsEnabled)}
        className={`flex items-center justify-center transition-colors hover:text-white ${
          captionsEnabled ? "text-white" : "text-slate-500"
        } ${className}`}
      >
        <Captions size={iconSize} aria-hidden="true" />
      </button>

      {menuOpen && hasMultipleTracks && (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-46 mb-2 min-w-40 rounded-lg border border-slate-700 bg-[#151821] py-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!captionsEnabled}
            onClick={() => {
              captionTrigger.setEnabled({ enabled: false });
              setMenuOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-slate-700 ${
              !captionsEnabled ? "font-semibold text-white" : "font-normal text-slate-300"
            }`}
          >
            <span className="w-4">
              {!captionsEnabled ? <Check size={14} aria-hidden="true" /> : null}
            </span>
            Off
          </button>
          {tracks.map((track) => {
            const isSelected = captionsEnabled && track.id === activeTrackId;
            return (
              <button
                key={track.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => {
                  captionTrigger.selectTrack({ trackId: track.id, language: track.language });
                  if (!captionsEnabled) captionTrigger.toggleEnabled();
                  setMenuOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-slate-700 ${
                  isSelected ? "font-semibold text-white" : "font-normal text-slate-300"
                }`}
              >
                <span className="w-4">
                  {isSelected ? <Check size={14} aria-hidden="true" /> : null}
                </span>
                {track.label || track.language}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CaptionsMenuButton;

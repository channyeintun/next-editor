import { useEffect, useState } from "react";
import { useIsBuffering } from "../hooks/useNextEditorContext";
import LoadingSpinner from "./LoadingSpinner";

/**
 * How long a hold must last before it shows. A seek holds the lesson for a few
 * milliseconds while the narration moves to the new position, and a spinner that blinks
 * on every seek reads as something broken.
 */
const BUFFERING_INDICATOR_DELAY_MS = 500;

/** Mounted for one hold, so each hold starts hidden and counts its own delay. */
function BufferingSpinner() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShown(true), BUFFERING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!shown) return null;

  return (
    <div className="pointer-events-none fixed top-1/2 left-1/2 z-110 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#11141c]/85 p-4">
      <LoadingSpinner label="Loading narration" />
    </div>
  );
}

/**
 * Shown in the middle of the lesson while it is held for its narration (a slow
 * connection): the lesson is waiting for the sound, not stuck. Pause and seek keep
 * working underneath.
 */
const PlaybackBufferingIndicator = () => (useIsBuffering() ? <BufferingSpinner /> : null);

export default PlaybackBufferingIndicator;

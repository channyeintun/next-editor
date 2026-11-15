import { useEffect, useState } from "react";
import { useIsBuffering } from "../hooks/useNextEditorContext";
import LoadingSpinner from "./LoadingSpinner";

/**
 * How long a hold must last before it shows. A seek holds the lesson for a few
 * milliseconds while the narration moves to the new position, and a spinner that blinks
 * on every seek reads as something broken.
 */
const BUFFERING_INDICATOR_DELAY_MS = 500;

/** Whether the lesson has been held long enough to say so. */
function useShowsBuffering(): boolean {
  const isBuffering = useIsBuffering();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!isBuffering) return;
    const timer = setTimeout(() => setShown(true), BUFFERING_INDICATOR_DELAY_MS);
    // Each hold starts hidden and counts its own delay.
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [isBuffering]);

  return isBuffering && shown;
}

/**
 * Shown in the middle of the lesson while it is held for its narration (a slow
 * connection): the lesson is waiting for the sound, not stuck. Pause and seek keep
 * working underneath.
 *
 * The live region stays mounted and only its text changes: a screen reader announces
 * what a live region comes to say, and often says nothing for one inserted already filled.
 * It is a polite live region of its own, not a second `role="status"`: the editor already
 * keeps one for a lesson that is loading.
 */
const PlaybackBufferingIndicator = () => {
  const shown = useShowsBuffering();

  return (
    <>
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {shown ? "Loading narration" : ""}
      </div>
      {shown && (
        <div className="pointer-events-none fixed top-1/2 left-1/2 z-110 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#11141c]/85 p-4">
          <LoadingSpinner label={null} />
        </div>
      )}
    </>
  );
};

export default PlaybackBufferingIndicator;

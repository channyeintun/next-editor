import { useEffect, useRef } from "react";

/**
 * Calls `onEnded` once per transition into the ended state, not on every render
 * while it stays ended, so a seek or replay that leaves and re-enters it re-arms it.
 */
export function useOnPlaybackEnded(hasEnded: boolean, onEnded: (() => void) | undefined): void {
  const wasEndedRef = useRef(false);

  useEffect(() => {
    if (hasEnded && !wasEndedRef.current) {
      onEnded?.();
    }
    wasEndedRef.current = hasEnded;
  }, [hasEnded, onEnded]);
}

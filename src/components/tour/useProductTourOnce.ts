import { useEffect, useRef } from "react";
import { startTour } from "./productTour";

interface ProductTourOnceOptions {
  recordingLoading: boolean;
  loadError: string | null;
  readOnly: boolean;
}

/**
 * Starts the product tour once per editor mount. Not inside read-only embeds (the
 * landing-page demo iframe), and only after any URL-driven recording load has
 * finished; never when the load failed — the editor is then showing an error
 * panel, not a touchable surface.
 */
export function useProductTourOnce({
  recordingLoading,
  loadError,
  readOnly,
}: ProductTourOnceOptions): void {
  const tourStartedRef = useRef(false);

  useEffect(() => {
    if (recordingLoading || loadError || readOnly || tourStartedRef.current) {
      return;
    }

    // Defer one frame so the lazily-mounted editor chrome (header, runner dock)
    // has painted before we query the `data-tour` targets. The frame is left to
    // fire on its own — cancelling it in cleanup would let StrictMode's dev
    // double-invoke abort the tour entirely (run #1 schedules, cleanup cancels,
    // run #2 short-circuits on the ref), so the tour would never auto-start.
    tourStartedRef.current = true;
    requestAnimationFrame(() => {
      void startTour();
    });
  }, [recordingLoading, loadError, readOnly]);
}

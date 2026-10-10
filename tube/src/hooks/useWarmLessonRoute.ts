import { useEffect, useState } from "react";
import { runWhenIdle } from "@app/utils/idle";
import { warmLessonRoute } from "../lessonRouteLoaders";
import { onScreenImages, whenImagesSettle } from "../lib/imagesSettled";

// On a throttled phone link the first row's thumbnails took about 1.4 s after
// the grid rendered; past this, warm the lesson route anyway, so a visitor who
// lingers on a slow page still gets an instant click.
const CONTENT_WAIT_CAP_MS = 5000;
const IDLE_TIMEOUT_MS = 2000;

/**
 * Warms the lesson route (see lessonRouteLoaders) from a page of lesson cards
 * once `contentReady` (its thumbnails) settles, then at idle. Not on card
 * hover, and not sooner: the lesson player is about 220 KB, and on a slow link
 * it would take its bandwidth from those thumbnails, the page's largest paint.
 */
export function useWarmLessonRoute(contentReady: Promise<void> | null): void {
  useEffect(() => {
    if (!contentReady) return;
    let cancelIdle: (() => void) | undefined;
    let cancelled = false;
    let capTimer = 0;
    const warmAtIdle = () => {
      if (cancelled || cancelIdle) return;
      window.clearTimeout(capTimer);
      cancelIdle = runWhenIdle(warmLessonRoute, IDLE_TIMEOUT_MS);
    };
    capTimer = window.setTimeout(warmAtIdle, CONTENT_WAIT_CAP_MS);
    void contentReady.then(warmAtIdle);
    return () => {
      cancelled = true;
      window.clearTimeout(capTimer);
      cancelIdle?.();
    };
  }, [contentReady]);
}

/**
 * Settles once the thumbnails on screen in `cards` have loaded or failed, for
 * a page of lesson cards without the gallery's first-row signal; null until
 * `cards` has mounted.
 */
export function useOnScreenThumbnailsSettled(cards: HTMLElement | null): Promise<void> | null {
  const [settled, setSettled] = useState<Promise<void> | null>(null);
  useEffect(() => {
    setSettled(cards ? whenImagesSettle(onScreenImages(cards)) : null);
  }, [cards]);
  return settled;
}

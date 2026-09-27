import type { Slide, SlidePreviewState } from "../types/slides";
import type { SlideStateSnapshot } from "../core/src/machine/types";
import { setSlidesStoreDeckBorrowed, type SlidesStoreInstance } from "./slidesStore";

// How the editor machine records and replays the slide deck: NextEditorProvider's
// getSlideState, applySlideState and applySlides hooks, over the app's slides store.

/** The deck's state as a recording frame stores it: the panel, and which slide it shows. */
export function readSlideRecordingState(store: SlidesStoreInstance): SlideStateSnapshot {
  const { slides, previewState } = store.getSnapshot().context;
  const currentSlideIndex = Math.max(
    0,
    slides.findIndex((s) => s.id === previewState.currentSlideId),
  );
  return { previewState, currentSlideIndex };
}

/**
 * Shows a recorded slide state. Fields the recording leaves out keep their current
 * values, and a state that changes nothing leaves the store alone.
 */
export function applySlideRecordingState(
  store: SlidesStoreInstance,
  slideState: SlidePreviewState,
): void {
  const { previewState: prev } = store.getSnapshot().context;

  const nextIsOpen = slideState.isOpen;
  const nextIsMaximized = slideState.isMaximized ?? prev.isMaximized ?? false;
  const nextSlideId = slideState.currentSlideId ?? prev.currentSlideId ?? null;
  const nextIndexv = slideState.indexv ?? prev.indexv ?? 0;
  const nextInteraction = slideState.currentInteraction;

  if (
    nextIsOpen !== prev.isOpen ||
    nextIsMaximized !== prev.isMaximized ||
    nextSlideId !== prev.currentSlideId ||
    nextIndexv !== prev.indexv ||
    nextInteraction !== prev.currentInteraction
  ) {
    store.trigger.setPreviewState({
      previewState: {
        isOpen: nextIsOpen,
        isMaximized: nextIsMaximized,
        currentSlideId: nextSlideId,
        indexv: nextIndexv,
        currentInteraction: nextInteraction,
      },
    });
  }
}

/** Shows a loaded recording's own deck. */
export function applyRecordingSlides(store: SlidesStoreInstance, slides: Slide[]): void {
  // These slides come from a loaded recording, not from this user. Marking
  // the deck borrowed keeps `subscribeSlidesPersistence` from writing the
  // lesson's deck over the viewer's own in the shared localStorage key —
  // which simply opening a published lesson used to do, unrecoverably.
  setSlidesStoreDeckBorrowed(store, true);
  store.trigger.setSlides({ slides });
}

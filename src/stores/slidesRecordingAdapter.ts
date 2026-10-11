import type { Slide, SlidePreviewState } from "../types/slides";
import type { SlideStateSnapshot } from "../core/src/machine/types";
import {
  areSlideDecksEqual,
  setSlidesStoreDeckBorrowed,
  type SlidesStoreInstance,
} from "./slidesStore";

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

  // Only these four are shown. A frame from an older recording may also carry the
  // interaction it was taken during (`currentInteraction`), which nothing reads; each
  // is a fresh object, so comparing it would re-render every slides consumer.
  if (
    nextIsOpen !== prev.isOpen ||
    nextIsMaximized !== prev.isMaximized ||
    nextSlideId !== prev.currentSlideId ||
    nextIndexv !== prev.indexv
  ) {
    store.trigger.setPreviewState({
      previewState: {
        isOpen: nextIsOpen,
        isMaximized: nextIsMaximized,
        currentSlideId: nextSlideId,
        indexv: nextIndexv,
      },
    });
  }
}

/**
 * Shows a loaded recording's own deck. A loaded deck is borrowed unless it is
 * the user's own current deck: the take they just stopped, which records the
 * store's deck and loads straight back.
 */
export function applyRecordingSlides(store: SlidesStoreInstance, slides: Slide[]): void {
  // A just-stopped take carries the author's own deck. Borrowing it kept every
  // later slide edit in the session from being saved.
  const { slides: current, deckBorrowed } = store.getSnapshot().context;
  if (!deckBorrowed && areSlideDecksEqual(current, slides)) return;
  // Any other deck comes from a loaded recording, not from this user. Marking
  // the deck borrowed keeps `subscribeSlidesPersistence` from writing the
  // lesson's deck over the viewer's own in the shared localStorage key —
  // which simply opening a published lesson used to do, unrecoverably.
  setSlidesStoreDeckBorrowed(store, true);
  store.trigger.setSlides({ slides });
}

import type { Slide, SlideEvent, SlidePreviewState } from "../../slides";
import { findTimedEventIndexAtOrBefore } from "./cursor";

// ============================================================================
// Slide track replay.
//
// Reconstructs the slide deck state (open/maximized/current slide/vertical index)
// at a given time by scanning back from the target event for the most recent
// navigation/structural/index event, then maps it onto a concrete slide index.
// ============================================================================

export interface SlideReplayApplication {
  slideIndex: number;
  slideState: SlidePreviewState;
}

export interface SlideReplayResult {
  applications: SlideReplayApplication[];
  nextIndex: number;
}

const SLIDE_VISIBILITY_EVENT_TYPES = new Set<SlideEvent["type"]>(["slide_open", "slide_close"]);

const SLIDE_STRUCTURAL_EVENT_TYPES = new Set<SlideEvent["type"]>([
  "slide_maximize",
  "slide_minimize",
]);

function buildSlideStateAtEvent(slideEvents: SlideEvent[], eventIndex: number): SlidePreviewState {
  const slideEvent = slideEvents[eventIndex];
  const relevantEvents = slideEvents.slice(0, eventIndex + 1).reverse();
  const lastVisibilityEvent = relevantEvents.find((event) =>
    SLIDE_VISIBILITY_EVENT_TYPES.has(event.type),
  );
  const lastPositionEvent = relevantEvents.find((event) => Boolean(event.slideId));
  const lastViewEvent = relevantEvents.find(
    (event) =>
      SLIDE_VISIBILITY_EVENT_TYPES.has(event.type) || SLIDE_STRUCTURAL_EVENT_TYPES.has(event.type),
  );
  const targetSlideId = slideEvent.slideId || lastPositionEvent?.slideId;
  const lastIndexEvent = relevantEvents.find(
    (event) =>
      (targetSlideId ? event.slideId === targetSlideId : true) &&
      event.indexv !== undefined &&
      event.indexv !== null,
  );
  const isOpen = lastVisibilityEvent?.type === "slide_open";
  const isMaximized =
    isOpen && lastViewEvent
      ? lastViewEvent.type === "slide_maximize"
        ? true
        : lastViewEvent.type === "slide_open"
          ? (lastViewEvent.isMaximized ?? false)
          : false
      : false;

  return {
    isOpen,
    isMaximized,
    currentSlideId: targetSlideId || null,
    indexv: slideEvent.type === "slide_close" ? 0 : (slideEvent.indexv ?? lastIndexEvent?.indexv),
    currentInteraction: slideEvent.interaction,
  };
}

function createSlideReplayApplication(
  slideEvents: SlideEvent[],
  slides: Slide[] | undefined,
  eventIndex: number,
): SlideReplayApplication | null {
  const slideEvent = slideEvents[eventIndex];
  const slideState = buildSlideStateAtEvent(slideEvents, eventIndex);
  const slideIndex =
    slideEvent.type === "slide_close"
      ? -1
      : (slides?.findIndex((slide) => slide.id === slideState.currentSlideId) ?? -1);

  if (slideIndex === -1 && slideEvent.type !== "slide_close") {
    return null;
  }

  return {
    slideIndex,
    slideState,
  };
}

export function getSlideReplayResult({
  slideEvents,
  slides,
  currentTime,
  lastAppliedIndex,
  isSeeking,
}: {
  slideEvents: SlideEvent[];
  slides?: Slide[];
  currentTime: number;
  lastAppliedIndex: number;
  isSeeking: boolean;
}): SlideReplayResult {
  if (isSeeking) {
    const nextIndex = findTimedEventIndexAtOrBefore(slideEvents, currentTime, -1);
    const application =
      nextIndex >= 0 ? createSlideReplayApplication(slideEvents, slides, nextIndex) : null;

    return {
      applications: application ? [application] : [],
      nextIndex,
    };
  }

  // Forward playback: apply every event crossed since the last tick, so a
  // navigation the viewer should see is not skipped over.
  let nextIndex = lastAppliedIndex;
  const applications: SlideReplayApplication[] = [];

  if (
    nextIndex >= 0 &&
    nextIndex < slideEvents.length &&
    slideEvents[nextIndex].timestamp > currentTime
  ) {
    nextIndex = -1;
  }

  for (let index = nextIndex + 1; index < slideEvents.length; index++) {
    const slideEvent = slideEvents[index];

    if (slideEvent.timestamp > currentTime) {
      break;
    }

    const application = createSlideReplayApplication(slideEvents, slides, index);

    if (application) {
      applications.push(application);
    }

    nextIndex = index;
  }

  return {
    applications,
    nextIndex,
  };
}

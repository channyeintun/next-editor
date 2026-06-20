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

const SLIDE_NAVIGATION_EVENT_TYPES = new Set<SlideEvent["type"]>([
  "slide_open",
  "slide_change",
  "slide_close",
]);

const SLIDE_STRUCTURAL_EVENT_TYPES = new Set<SlideEvent["type"]>([
  "slide_maximize",
  "slide_minimize",
]);

function buildSlideStateAtEvent(slideEvents: SlideEvent[], eventIndex: number): SlidePreviewState {
  const slideEvent = slideEvents[eventIndex];

  if (slideEvent.type === "slide_close") {
    return {
      isOpen: false,
      currentSlideId: null,
      indexv: 0,
      currentInteraction: undefined,
    };
  }

  const relevantEvents = slideEvents.slice(0, eventIndex + 1).reverse();
  const lastNavigationEvent = relevantEvents.find((event) =>
    SLIDE_NAVIGATION_EVENT_TYPES.has(event.type),
  );
  const lastStructuralEvent = relevantEvents.find((event) =>
    SLIDE_STRUCTURAL_EVENT_TYPES.has(event.type),
  );
  const targetSlideId = slideEvent.slideId || lastNavigationEvent?.slideId;
  const lastIndexEvent = relevantEvents.find(
    (event) =>
      (targetSlideId ? event.slideId === targetSlideId : true) &&
      event.indexv !== undefined &&
      event.indexv !== null,
  );

  return {
    isOpen: (lastNavigationEvent?.type || slideEvent.type) !== "slide_close",
    isMaximized: lastStructuralEvent
      ? lastStructuralEvent.type === "slide_maximize"
      : (slideEvent.isMaximized ?? lastNavigationEvent?.isMaximized ?? false),
    currentSlideId: slideEvent.slideId || lastNavigationEvent?.slideId || null,
    indexv: slideEvent.indexv ?? lastIndexEvent?.indexv ?? lastNavigationEvent?.indexv,
    currentInteraction: slideEvent.interaction,
  };
}

function createSlideReplayApplication(
  slideEvents: SlideEvent[],
  slides: Slide[] | undefined,
  eventIndex: number,
): SlideReplayApplication | null {
  const slideEvent = slideEvents[eventIndex];
  const slideIndex = slides?.findIndex((slide) => slide.id === slideEvent.slideId) ?? -1;

  if (slideIndex === -1 && slideEvent.type !== "slide_close") {
    return null;
  }

  return {
    slideIndex,
    slideState: buildSlideStateAtEvent(slideEvents, eventIndex),
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

  let nextIndex = lastAppliedIndex;
  const applications: SlideReplayApplication[] = [];

  if (
    nextIndex >= 0 &&
    nextIndex < slideEvents.length &&
    slideEvents[nextIndex].timestamp > currentTime
  ) {
    nextIndex = -1;
  }

  let lastMatchedEventIndex = -1;

  for (let index = nextIndex + 1; index < slideEvents.length; index++) {
    const slideEvent = slideEvents[index];

    if (slideEvent.timestamp > currentTime) {
      break;
    }

    if (isSeeking) {
      lastMatchedEventIndex = index;
    } else {
      const application = createSlideReplayApplication(slideEvents, slides, index);

      if (application) {
        applications.push(application);
      }
    }

    nextIndex = index;
  }

  if (isSeeking && lastMatchedEventIndex >= 0) {
    const application = createSlideReplayApplication(slideEvents, slides, lastMatchedEventIndex);

    if (application) {
      applications.push(application);
    }
  }

  return {
    applications,
    nextIndex,
  };
}

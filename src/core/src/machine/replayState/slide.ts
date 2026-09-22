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

/**
 * The deck before the first slide event. No visibility event yet means closed (see
 * `buildSlideStateAtEvent`), and the recorder writes a t=0 `slide_open` only when
 * the deck was already open when recording started.
 */
const CLOSED_SLIDE_APPLICATION: SlideReplayApplication = {
  slideIndex: -1,
  slideState: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
};

/**
 * The most recent matching event at or before `eventIndex`. Scanning backwards
 * in place (rather than reversing a copy of the prefix) keeps state reconstruction
 * allocation-free and lets each query stop at its first hit — which for these
 * predicates is usually within a few events.
 */
function findLastEventAtOrBefore(
  slideEvents: SlideEvent[],
  eventIndex: number,
  matches: (event: SlideEvent) => boolean,
): SlideEvent | undefined {
  for (let index = eventIndex; index >= 0; index -= 1) {
    if (matches(slideEvents[index])) {
      return slideEvents[index];
    }
  }
  return undefined;
}

function buildSlideStateAtEvent(slideEvents: SlideEvent[], eventIndex: number): SlidePreviewState {
  const slideEvent = slideEvents[eventIndex];
  const lastVisibilityEvent = findLastEventAtOrBefore(slideEvents, eventIndex, (event) =>
    SLIDE_VISIBILITY_EVENT_TYPES.has(event.type),
  );
  const lastPositionEvent = findLastEventAtOrBefore(slideEvents, eventIndex, (event) =>
    Boolean(event.slideId),
  );
  const lastViewEvent = findLastEventAtOrBefore(
    slideEvents,
    eventIndex,
    (event) =>
      SLIDE_VISIBILITY_EVENT_TYPES.has(event.type) || SLIDE_STRUCTURAL_EVENT_TYPES.has(event.type),
  );
  const targetSlideId = slideEvent.slideId || lastPositionEvent?.slideId;
  const lastIndexEvent = findLastEventAtOrBefore(
    slideEvents,
    eventIndex,
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
  isResync,
}: {
  slideEvents: SlideEvent[];
  slides?: Slide[];
  currentTime: number;
  lastAppliedIndex: number;
  /** See `isReplayResync`: apply the one state at `currentTime` instead of replaying history. */
  isResync: boolean;
}): SlideReplayResult {
  if (isResync) {
    const nextIndex = findTimedEventIndexAtOrBefore(slideEvents, currentTime, -1);
    // Before the first slide event the deck is closed. Applying nothing there left a
    // deck opened later in the recording on screen after a backward seek, STOP or
    // restart.
    const application =
      nextIndex >= 0
        ? createSlideReplayApplication(slideEvents, slides, nextIndex)
        : CLOSED_SLIDE_APPLICATION;

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

  // A tick that rewound the cursor to before the first event closes the deck once.
  // The cursor is -1 afterwards, so later ticks before that event apply nothing.
  if (nextIndex < 0 && lastAppliedIndex >= 0) {
    applications.push(CLOSED_SLIDE_APPLICATION);
  }

  return {
    applications,
    nextIndex,
  };
}

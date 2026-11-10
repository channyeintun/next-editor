import {
  isSlideViewEvent,
  type Slide,
  type SlideEvent,
  type SlidePreviewState,
} from "../../slides";
import { findTimedEventIndexAtOrBefore } from "../../utils/timedIndex";
import { isCursorAheadOf } from "./cursor";
import { createViewChangeResolver } from "./viewChanges";

// ============================================================================
// Slide track replay.
//
// Reconstructs the slide deck state (open/maximized/current slide/vertical index)
// at a given event from the most recent navigation/structural/index event at or
// before it, then maps it onto a concrete slide index. Where those most recent
// events are is kept per track (see SlideTrackIndex), so a tick that crosses many
// events does not scan the track back from each of them.
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

/** The vertical index a closed deck reports. */
const CLOSED_DECK_INDEXV = 0;

/**
 * The deck before the first slide event it can place. No visibility event yet means closed (see
 * `buildSlideStateAtEvent`), and the recorder writes a t=0 `slide_open` only when
 * the deck was already open when recording started.
 */
const CLOSED_SLIDE_APPLICATION: SlideReplayApplication = {
  slideIndex: -1,
  slideState: {
    isOpen: false,
    isMaximized: false,
    currentSlideId: null,
    indexv: CLOSED_DECK_INDEXV,
  },
};

/**
 * Where a slide track last set each part of the deck state. `lastX[i]` is the index
 * of the latest event at or before i that set X, or -1.
 *
 * buildSlideStateAtEvent used to find these by scanning back from the event, once
 * per lookup. A forward tick asks for every event it crosses, and a lookup with
 * nothing to find (a close on a track that names no slide) ran back to the start of
 * the track. A lesson file can put any number of events on one timestamp, so one
 * tick over n of them cost n²/2 steps inside a state machine action on the viewer's
 * main thread. The index is a prefix fold instead: each event is read once, however
 * the playhead gets there.
 */
interface SlideTrackIndex {
  /** The latest `slide_open` or `slide_close`. */
  lastVisibility: number[];
  /** The latest event that changed how the deck is shown (see `isSlideViewEvent`). */
  lastView: number[];
  /** The latest event that names a slide. */
  lastPosition: number[];
  /** The latest event that set a vertical index for the slide shown at i. */
  lastIndexv: number[];
  /** Fold state: per slide, the latest event so far that set its vertical index. */
  indexvBySlideId: Map<SlideEvent["slideId"], number>;
  /** Fold state: the latest event so far that set a vertical index, whatever it names. */
  lastAnyIndexv: number;
}

const slideTrackIndexCache = new WeakMap<SlideEvent[], SlideTrackIndex>();

/**
 * The track's index, folded through `eventIndex` at least. It is extended only as
 * far as it is asked, and kept per events array, which streamed playback only ever
 * appends to in place.
 */
function getSlideTrackIndex(slideEvents: SlideEvent[], eventIndex: number): SlideTrackIndex {
  let trackIndex = slideTrackIndexCache.get(slideEvents);
  if (!trackIndex) {
    trackIndex = {
      lastVisibility: [],
      lastView: [],
      lastPosition: [],
      lastIndexv: [],
      indexvBySlideId: new Map(),
      lastAnyIndexv: -1,
    };
    slideTrackIndexCache.set(slideEvents, trackIndex);
  }

  const { lastVisibility, lastView, lastPosition, lastIndexv, indexvBySlideId } = trackIndex;
  for (let cursor = lastPosition.length; cursor <= eventIndex; cursor += 1) {
    const slideEvent = slideEvents[cursor];
    const { slideId } = slideEvent;
    const position = slideId ? cursor : (lastPosition[cursor - 1] ?? -1);

    if (slideEvent.indexv != null) {
      indexvBySlideId.set(slideId, cursor);
      trackIndex.lastAnyIndexv = cursor;
    }
    // The slide shown at this event is the one the latest position event names. Before
    // any event names a slide, the vertical index is the last one set at all.
    const shownSlideId = slideId || slideEvents[position]?.slideId;

    lastVisibility.push(
      SLIDE_VISIBILITY_EVENT_TYPES.has(slideEvent.type)
        ? cursor
        : (lastVisibility[cursor - 1] ?? -1),
    );
    lastView.push(isSlideViewEvent(slideEvent) ? cursor : (lastView[cursor - 1] ?? -1));
    lastPosition.push(position);
    lastIndexv.push(
      shownSlideId ? (indexvBySlideId.get(shownSlideId) ?? -1) : trackIndex.lastAnyIndexv,
    );
  }

  return trackIndex;
}

/** Whether the deck is maximized after `lastViewEvent`, the latest view event. */
function resolveMaximized(lastViewEvent: SlideEvent | undefined): boolean {
  if (lastViewEvent?.type === "slide_maximize") return true;
  if (lastViewEvent?.type === "slide_open") return lastViewEvent.isMaximized ?? false;
  return false;
}

/** The deck state at `eventIndex`: what the latest events at or before it left. */
function buildSlideStateAtEvent(slideEvents: SlideEvent[], eventIndex: number): SlidePreviewState {
  const slideEvent = slideEvents[eventIndex];
  const trackIndex = getSlideTrackIndex(slideEvents, eventIndex);
  // The event's own slide when it names one: it is then its own latest position event.
  const targetSlideId = slideEvents[trackIndex.lastPosition[eventIndex]]?.slideId;
  const isOpen = slideEvents[trackIndex.lastVisibility[eventIndex]]?.type === "slide_open";
  const isMaximized = isOpen && resolveMaximized(slideEvents[trackIndex.lastView[eventIndex]]);

  let indexv: number | undefined;
  if (slideEvent.type === "slide_close") {
    indexv = CLOSED_DECK_INDEXV;
  } else if (slideEvent.indexv != null) {
    indexv = slideEvent.indexv;
  } else {
    indexv = slideEvents[trackIndex.lastIndexv[eventIndex]]?.indexv;
  }

  return {
    isOpen,
    isMaximized,
    currentSlideId: targetSlideId || null,
    indexv,
  };
}

const deckIndexCache = new WeakMap<Slide[], Map<SlidePreviewState["currentSlideId"], number>>();

/**
 * Where the slide with `slideId` is in the deck, or -1. Kept per deck, which a
 * recording saves once and never edits: every crossed event asks, and searching the
 * deck each time cost events x slides comparisons on a tick over a long track.
 */
function findSlideIndex(
  slides: Slide[] | undefined,
  slideId: SlidePreviewState["currentSlideId"],
): number {
  if (!slides) {
    return -1;
  }

  let indexById = deckIndexCache.get(slides);
  if (!indexById) {
    indexById = new Map();
    for (let index = 0; index < slides.length; index += 1) {
      const { id } = slides[index];
      // The first slide with an id is the one a search from the front finds.
      if (!indexById.has(id)) {
        indexById.set(id, index);
      }
    }
    deckIndexCache.set(slides, indexById);
  }

  return indexById.get(slideId) ?? -1;
}

function createSlideReplayApplication(
  slideEvents: SlideEvent[],
  slides: Slide[] | undefined,
  eventIndex: number,
): SlideReplayApplication | null {
  const slideEvent = slideEvents[eventIndex];
  // Without a deck only a close can be placed, so skip resolving the state.
  if (slideEvent.type !== "slide_close" && !slides?.length) {
    return null;
  }
  const slideState = buildSlideStateAtEvent(slideEvents, eventIndex);
  const slideIndex =
    slideEvent.type === "slide_close" ? -1 : findSlideIndex(slides, slideState.currentSlideId);

  if (slideIndex === -1 && slideEvent.type !== "slide_close") {
    return null;
  }

  return {
    slideIndex,
    slideState,
  };
}

/**
 * The last event at or before `eventIndex` that {@link createSlideReplayApplication}
 * can place, or -1. A close always places; any other event places when the slide it
 * shows (its own slideId, else the nearest earlier one) is in the deck. So every event
 * from one slideId-bearing event up to the next shows the same slide: such a run places
 * its newest event, or only its closes. One pass back finds the answer, without
 * resolving a deck state for each event on a long track that places nothing.
 */
function findLastPlaceableEventIndex(
  slideEvents: SlideEvent[],
  slides: Slide[] | undefined,
  eventIndex: number,
): number {
  let runEnd = eventIndex;
  let runClose = -1;
  for (let index = eventIndex; index >= 0; index -= 1) {
    const { type, slideId } = slideEvents[index];
    if (type === "slide_close" && runClose < 0) {
      runClose = index;
    }
    if (!slideId) {
      continue;
    }
    if (findSlideIndex(slides, slideId) >= 0) {
      return runEnd;
    }
    if (runClose >= 0) {
      return runClose;
    }
    runEnd = index - 1;
  }
  return runClose;
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
  if (isResync || isCursorAheadOf(slideEvents, lastAppliedIndex, currentTime)) {
    const nextIndex = findTimedEventIndexAtOrBefore(slideEvents, currentTime, -1);
    // Show what forward playback shows at `currentTime`: the last event the deck can
    // place. An event whose slide was deleted during the take applies nothing on a
    // tick, so it must not change the deck on a seek either. Before the first such
    // event the deck is closed. Applying nothing there left a deck opened later in
    // the recording on screen after a backward seek, STOP or restart.
    const placedIndex = findLastPlaceableEventIndex(slideEvents, slides, nextIndex);
    const application =
      (placedIndex >= 0 && createSlideReplayApplication(slideEvents, slides, placedIndex)) ||
      CLOSED_SLIDE_APPLICATION;

    return {
      applications: [application],
      nextIndex,
    };
  }

  // Forward playback: apply every event crossed since the last tick, so a
  // navigation the viewer should see is not skipped over.
  let nextIndex = lastAppliedIndex;
  const applications: SlideReplayApplication[] = [];

  for (let index = lastAppliedIndex + 1; index < slideEvents.length; index++) {
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

/** How the deck is shown: the part of its state a viewer may change while a lesson plays. */
export type SlidePanelView = Required<Pick<SlidePreviewState, "isOpen" | "isMaximized">>;

/**
 * The latest slide event at or before `index` that changed how the deck is shown, as
 * `buildSlideStateAtEvent` shows it: opened or closed, maximized or minimized, or -1. A
 * navigation, or a `slide_open` on a deck already open as it leaves it, is not a change.
 */
export const getSlideViewChangeIndex = createViewChangeResolver<SlideEvent, SlidePanelView>({
  initial: { isOpen: false, isMaximized: false },
  next: (view, event) => {
    if (!isSlideViewEvent(event)) return view;
    const isOpen = SLIDE_VISIBILITY_EVENT_TYPES.has(event.type)
      ? event.type === "slide_open"
      : view.isOpen;
    return { isOpen, isMaximized: isOpen && resolveMaximized(event) };
  },
  isSameView: (left, right) =>
    left.isOpen === right.isOpen && left.isMaximized === right.isMaximized,
});

/** A recorded deck state with the deck shown as `view` has it. */
export function withSlideView(
  slideState: SlidePreviewState,
  view: SlidePanelView,
): SlidePreviewState {
  return { ...slideState, isOpen: view.isOpen, isMaximized: view.isMaximized };
}

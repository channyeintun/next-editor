import type { PreviewEvent, PreviewState, Slide, SlideEvent, SlidePreviewState } from "../slides";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../types/runtime";
import {
  areWorkspaceSnapshotsEqual,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "../../../types/workspace";

type ReplayTriggerEvent = {
  type: string;
  currentTime?: number;
  time?: number;
};

interface TimedReplayEvent {
  timestamp: number;
}

interface ReplayCursorResult<T extends TimedReplayEvent> {
  latestEvent: T | null;
  nextIndex: number;
}

interface PreviewReplayIndex {
  retainedStates: PreviewState[];
}

export interface PreviewReplayResult {
  appliedStates: PreviewState[];
  nextIndex: number;
  retainedState?: PreviewState;
}

export interface WorkspaceReplayResult {
  nextIndex: number;
  snapshotToApply?: WorkspaceRecordingSnapshot;
}

export interface RuntimeReplayResult {
  nextIndex: number;
  snapshotToApply?: RuntimeRecordingSnapshot;
}

export interface SlideReplayApplication {
  slideIndex: number;
  slideState: SlidePreviewState;
}

export interface SlideReplayResult {
  applications: SlideReplayApplication[];
  nextIndex: number;
}

const LINEAR_SCAN_LIMIT = 128;
const previewReplayIndexCache = new WeakMap<PreviewEvent[], PreviewReplayIndex>();

export function resolveReplayTime(event: ReplayTriggerEvent, fallbackTime: number): number {
  if (event.type === "TICK") {
    return event.currentTime ?? fallbackTime;
  }

  if (event.type === "SEEK") {
    return event.time ?? fallbackTime;
  }

  return fallbackTime;
}

export function isSeekReplayEvent(event: ReplayTriggerEvent): boolean {
  return event.type === "SEEK";
}

export function advanceReplayCursor<T extends TimedReplayEvent>({
  events,
  currentTime,
  lastAppliedIndex,
}: {
  events: T[];
  currentTime: number;
  lastAppliedIndex: number;
}): ReplayCursorResult<T> {
  const nextIndex = findTimedEventIndexAtOrBefore(events, currentTime, lastAppliedIndex);
  const latestEvent = nextIndex >= 0 ? events[nextIndex] : null;

  return {
    latestEvent,
    nextIndex,
  };
}

function findTimedEventIndexAtOrBefore<T extends TimedReplayEvent>(
  events: T[],
  currentTime: number,
  startIndex: number,
): number {
  if (!events.length) {
    return -1;
  }

  const lastIndex = events.length - 1;
  const hasValidStartIndex = startIndex >= 0 && startIndex <= lastIndex;

  if (!hasValidStartIndex) {
    return findTimedEventIndexAtOrBeforeBinary(events, currentTime, 0, lastIndex);
  }

  if (events[startIndex].timestamp > currentTime) {
    return findTimedEventIndexAtOrBeforeBinary(events, currentTime, 0, startIndex);
  }

  if (startIndex === lastIndex || events[startIndex + 1].timestamp > currentTime) {
    return startIndex;
  }

  const scanEnd = Math.min(lastIndex, startIndex + LINEAR_SCAN_LIMIT);

  for (let index = startIndex + 1; index <= scanEnd; index++) {
    if (events[index].timestamp > currentTime) {
      return index - 1;
    }
  }

  if (scanEnd === lastIndex) {
    return lastIndex;
  }

  return findTimedEventIndexAtOrBeforeBinary(events, currentTime, scanEnd, lastIndex);
}

function findTimedEventIndexAtOrBeforeBinary<T extends TimedReplayEvent>(
  events: T[],
  currentTime: number,
  low: number,
  high: number,
): number {
  let nearestIndex = low > 0 ? low - 1 : -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    if (events[mid].timestamp <= currentTime) {
      nearestIndex = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return nearestIndex;
}

function mergePreviewEventState(
  previewEvent: PreviewEvent,
  previousState?: PreviewState,
): { appliedState: PreviewState; retainedState: PreviewState } {
  const isCloseEvent = previewEvent.type === "preview_close";
  const nextIsOpen = previewEvent.isOpen ?? (isCloseEvent ? false : previousState?.isOpen);
  const nextMode = previewEvent.mode ?? previousState?.mode;
  const appliedState: PreviewState = {
    size: previewEvent.size ?? previousState?.size ?? "small",
    content: previewEvent.content ?? previousState?.content,
    route: previewEvent.route ?? previousState?.route,
    scrollTop: previewEvent.scrollTop ?? previousState?.scrollTop,
    scrollLeft: previewEvent.scrollLeft ?? previousState?.scrollLeft,
    refreshKey:
      previewEvent.type === "preview_refresh" ? previewEvent.timestamp : previousState?.refreshKey,
    currentInteraction: previewEvent.interaction,
  };

  if (nextIsOpen !== undefined) {
    appliedState.isOpen = nextIsOpen;
  }

  if (nextMode !== undefined) {
    appliedState.mode = nextMode;
  }

  return {
    appliedState,
    retainedState: {
      ...appliedState,
      currentInteraction: undefined,
    },
  };
}

function getPreviewReplayIndex(previewEvents: PreviewEvent[]): PreviewReplayIndex {
  const cachedIndex = previewReplayIndexCache.get(previewEvents);

  if (cachedIndex) {
    return cachedIndex;
  }

  let retainedState: PreviewState | undefined;
  const retainedStates: PreviewState[] = [];

  for (const previewEvent of previewEvents) {
    const nextPreviewState = mergePreviewEventState(previewEvent, retainedState);
    retainedState = nextPreviewState.retainedState;
    retainedStates.push(retainedState);
  }

  const replayIndex = { retainedStates };
  previewReplayIndexCache.set(previewEvents, replayIndex);
  return replayIndex;
}

function clonePreviewReplayState(previewState: PreviewState): PreviewState {
  return {
    ...previewState,
    currentInteraction: undefined,
  };
}

export function getPreviewReplayResult({
  previewEvents,
  currentTime,
  lastAppliedIndex,
  lastAppliedState,
  isSeeking,
}: {
  previewEvents: PreviewEvent[];
  currentTime: number;
  lastAppliedIndex: number;
  lastAppliedState?: PreviewState;
  isSeeking: boolean;
}): PreviewReplayResult {
  if (isSeeking) {
    const nextIndex = findTimedEventIndexAtOrBefore(previewEvents, currentTime, -1);

    if (nextIndex < 0) {
      return {
        appliedStates: [],
        nextIndex,
        retainedState: undefined,
      };
    }

    const retainedState = clonePreviewReplayState(
      getPreviewReplayIndex(previewEvents).retainedStates[nextIndex],
    );

    return {
      appliedStates: [retainedState],
      nextIndex,
      retainedState,
    };
  }

  let nextIndex = isSeeking ? -1 : lastAppliedIndex;
  let retainedState = isSeeking ? undefined : lastAppliedState;
  const appliedStates: PreviewState[] = [];

  if (
    nextIndex >= 0 &&
    nextIndex < previewEvents.length &&
    previewEvents[nextIndex].timestamp > currentTime
  ) {
    nextIndex = -1;
    retainedState = undefined;
  }

  for (let index = nextIndex + 1; index < previewEvents.length; index++) {
    const previewEvent = previewEvents[index];

    if (previewEvent.timestamp > currentTime) {
      break;
    }

    const nextPreviewState = mergePreviewEventState(previewEvent, retainedState);

    if (!isSeeking) {
      appliedStates.push(nextPreviewState.appliedState);
    }

    retainedState = nextPreviewState.retainedState;
    nextIndex = index;
  }

  if (isSeeking && retainedState) {
    appliedStates.push(retainedState);
  }

  return {
    appliedStates,
    nextIndex,
    retainedState,
  };
}

export function getWorkspaceReplayResult({
  workspaceEvents,
  currentTime,
  currentSnapshot,
  getCurrentSnapshot,
  lastAppliedIndex,
}: {
  workspaceEvents: WorkspaceRecordingEvent[];
  currentTime: number;
  currentSnapshot?: WorkspaceRecordingSnapshot | null;
  getCurrentSnapshot?: () => WorkspaceRecordingSnapshot | null;
  lastAppliedIndex: number;
}): WorkspaceReplayResult {
  const replayCursor = advanceReplayCursor({
    events: workspaceEvents,
    currentTime,
    lastAppliedIndex,
  });

  if (replayCursor.latestEvent && replayCursor.nextIndex !== lastAppliedIndex) {
    const snapshot =
      currentSnapshot !== undefined ? currentSnapshot : (getCurrentSnapshot?.() ?? null);

    if (!snapshot || !areWorkspaceSnapshotsEqual(snapshot, replayCursor.latestEvent.snapshot)) {
      return {
        nextIndex: replayCursor.nextIndex,
        snapshotToApply: replayCursor.latestEvent.snapshot,
      };
    }
  }

  return {
    nextIndex: replayCursor.nextIndex,
  };
}

export function getRuntimeReplayResult({
  runtimeEvents,
  currentTime,
  lastAppliedIndex,
}: {
  runtimeEvents: RuntimeRecordingEvent[];
  currentTime: number;
  lastAppliedIndex: number;
}): RuntimeReplayResult {
  const replayCursor = advanceReplayCursor({
    events: runtimeEvents,
    currentTime,
    lastAppliedIndex,
  });

  if (replayCursor.latestEvent && replayCursor.nextIndex !== lastAppliedIndex) {
    return {
      nextIndex: replayCursor.nextIndex,
      snapshotToApply: replayCursor.latestEvent.snapshot,
    };
  }

  return {
    nextIndex: replayCursor.nextIndex,
  };
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

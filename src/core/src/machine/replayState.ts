import type {
  PreviewEvent,
  PreviewState,
  Slide,
  SlideEvent,
  SlidePreviewState,
} from "../slides";
import type {
  RuntimeRecordingEvent,
  RuntimeRecordingSnapshot,
} from "../../../types/runtime";
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

export function resolveReplayTime(
  event: ReplayTriggerEvent,
  fallbackTime: number,
): number {
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
  let nextIndex = lastAppliedIndex;

  if (
    nextIndex >= 0 &&
    nextIndex < events.length &&
    events[nextIndex].timestamp > currentTime
  ) {
    nextIndex = -1;
  }

  let latestEvent = nextIndex >= 0 ? events[nextIndex] : null;

  for (let index = nextIndex + 1; index < events.length; index++) {
    const replayEvent = events[index];

    if (replayEvent.timestamp > currentTime) {
      break;
    }

    latestEvent = replayEvent;
    nextIndex = index;
  }

  return {
    latestEvent,
    nextIndex,
  };
}

function mergePreviewEventState(
  previewEvent: PreviewEvent,
  previousState?: PreviewState,
): { appliedState: PreviewState; retainedState: PreviewState } {
  const appliedState: PreviewState = {
    size: previewEvent.size ?? previousState?.size ?? "small",
    content: previewEvent.content ?? previousState?.content,
    scrollTop: previewEvent.scrollTop ?? previousState?.scrollTop,
    scrollLeft: previewEvent.scrollLeft ?? previousState?.scrollLeft,
    refreshKey:
      previewEvent.type === "preview_refresh"
        ? previewEvent.timestamp
        : previousState?.refreshKey,
    currentInteraction: previewEvent.interaction,
  };

  return {
    appliedState,
    retainedState: {
      ...appliedState,
      currentInteraction: undefined,
    },
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

    const nextPreviewState = mergePreviewEventState(
      previewEvent,
      retainedState,
    );

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
  lastAppliedIndex,
}: {
  workspaceEvents: WorkspaceRecordingEvent[];
  currentTime: number;
  currentSnapshot: WorkspaceRecordingSnapshot | null;
  lastAppliedIndex: number;
}): WorkspaceReplayResult {
  const replayCursor = advanceReplayCursor({
    events: workspaceEvents,
    currentTime,
    lastAppliedIndex,
  });

  if (
    replayCursor.latestEvent &&
    replayCursor.nextIndex !== lastAppliedIndex &&
    (!currentSnapshot ||
      !areWorkspaceSnapshotsEqual(
        currentSnapshot,
        replayCursor.latestEvent.snapshot,
      ))
  ) {
    return {
      nextIndex: replayCursor.nextIndex,
      snapshotToApply: replayCursor.latestEvent.snapshot,
    };
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

function buildSlideStateAtEvent(
  slideEvents: SlideEvent[],
  eventIndex: number,
): SlidePreviewState {
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
    indexv:
      slideEvent.indexv ??
      lastIndexEvent?.indexv ??
      lastNavigationEvent?.indexv,
    currentInteraction: slideEvent.interaction,
  };
}

function createSlideReplayApplication(
  slideEvents: SlideEvent[],
  slides: Slide[] | undefined,
  eventIndex: number,
): SlideReplayApplication | null {
  const slideEvent = slideEvents[eventIndex];
  const slideIndex =
    slides?.findIndex((slide) => slide.id === slideEvent.slideId) ?? -1;

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
      const application = createSlideReplayApplication(
        slideEvents,
        slides,
        index,
      );

      if (application) {
        applications.push(application);
      }
    }

    nextIndex = index;
  }

  if (isSeeking && lastMatchedEventIndex >= 0) {
    const application = createSlideReplayApplication(
      slideEvents,
      slides,
      lastMatchedEventIndex,
    );

    if (application) {
      applications.push(application);
    }
  }

  return {
    applications,
    nextIndex,
  };
}

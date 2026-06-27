import type { PreviewEvent, PreviewState } from "../../slides";
import { findTimedEventIndexAtOrBefore } from "./cursor";

// ============================================================================
// Preview track replay.
//
// Rebuilds the preview iframe's state (open/mode/size/route/scroll/refresh) for a
// given time. During seeks the per-event "retained" states are precomputed and
// cached so jumping to any point is O(1) without replaying transient interactions.
// ============================================================================

interface PreviewReplayIndex {
  retainedStates: PreviewState[];
}

export interface PreviewReplayResult {
  appliedStates: PreviewState[];
  nextIndex: number;
  retainedState?: PreviewState;
}

const previewReplayIndexCache = new WeakMap<PreviewEvent[], PreviewReplayIndex>();

function mergePreviewEventState(
  previewEvent: PreviewEvent,
  previousState?: PreviewState,
): { appliedState: PreviewState; retainedState: PreviewState } {
  const isCloseEvent = previewEvent.type === "preview_close";
  // Float/unfloat change the iframe's width, so its content reflows. The browser
  // already preserves the scroll position across that reflow (which is why it looks
  // correct during live recording). Re-applying a recorded scroll on the mode-change
  // event during playback instead jumps the content out of view — the iframe looks
  // empty until the next scroll event corrects it. So we carry the scroll forward
  // for continuity/seeking, but don't re-assert it on the mode change itself.
  const isModeChangeEvent =
    previewEvent.type === "preview_float" || previewEvent.type === "preview_unfloat";
  const nextIsOpen = previewEvent.isOpen ?? (isCloseEvent ? false : previousState?.isOpen);
  const nextMode = previewEvent.mode ?? previousState?.mode;
  const carriedScrollTop = previewEvent.scrollTop ?? previousState?.scrollTop;
  const carriedScrollLeft = previewEvent.scrollLeft ?? previousState?.scrollLeft;
  const nextActiveMode = previewEvent.activeMode ?? previousState?.activeMode;
  const nextRequestTab = previewEvent.requestTab ?? previousState?.requestTab;

  // API client interactions inherently happen in the API frame, so a request or
  // response implies API mode even if the explicit mode-switch event wasn't
  // captured (e.g. the user was already in API mode when recording started).
  const impliesApiMode =
    previewEvent.type === "api_client_request" ||
    previewEvent.type === "api_client_response" ||
    previewEvent.type === "api_client_request_tab" ||
    previewEvent.type === "api_client_inspect_history";
  const resolvedActiveMode = impliesApiMode ? "api" : nextActiveMode;

  let nextApiClientState = previousState?.apiClientState;
  if (previewEvent.type === "api_client_request") {
    nextApiClientState = {
      request: previewEvent.apiClientRequest,
      sending: true,
      history: previousState?.apiClientState?.history,
    };
  } else if (previewEvent.type === "api_client_response" && previewEvent.apiClientResult) {
    const previousApiClientState = previousState?.apiClientState;
    const historyEntry = {
      id: String(previewEvent.timestamp),
      request: previousApiClientState?.request,
      result: previewEvent.apiClientResult,
    };
    nextApiClientState = {
      request: previousApiClientState?.request,
      result: previewEvent.apiClientResult,
      sending: false,
      // Newest first, matching the live store; cap mirrors the store's MAX_HISTORY.
      history: [historyEntry, ...(previousApiClientState?.history ?? [])].slice(0, 25),
    };
  } else if (previewEvent.type === "api_client_inspect_history" && previewEvent.apiClientInspect) {
    // Inspecting a history entry restores its method/path/result (like the live
    // store's selectFromHistory), keeping the current headers/body and history.
    const previousApiClientState = previousState?.apiClientState;
    const inspect = previewEvent.apiClientInspect;
    const previousRequest = previousApiClientState?.request;
    nextApiClientState = {
      ...previousApiClientState,
      request: previousRequest
        ? { ...previousRequest, method: inspect.method, path: inspect.path }
        : { method: inspect.method, path: inspect.path, headers: {}, body: undefined },
      result: inspect.result,
      sending: false,
    };
  }

  const appliedState: PreviewState = {
    size: previewEvent.size ?? previousState?.size ?? "small",
    content: previewEvent.content ?? previousState?.content,
    route: previewEvent.route ?? previousState?.route,
    scrollTop: isModeChangeEvent ? undefined : carriedScrollTop,
    scrollLeft: isModeChangeEvent ? undefined : carriedScrollLeft,
    refreshKey:
      previewEvent.type === "preview_refresh" ? previewEvent.timestamp : previousState?.refreshKey,
    currentInteraction: previewEvent.interaction,
    activeMode: resolvedActiveMode,
    requestTab: nextRequestTab,
    apiClientState: nextApiClientState,
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
      scrollTop: carriedScrollTop,
      scrollLeft: carriedScrollLeft,
      currentInteraction: undefined,
      activeMode: resolvedActiveMode,
      requestTab: nextRequestTab,
      apiClientState: nextApiClientState,
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

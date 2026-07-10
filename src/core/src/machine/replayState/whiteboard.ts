import {
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../../whiteboard";
import { findTimedEventIndexAtOrBefore } from "./cursor";

// ============================================================================
// Whiteboard track replay.
//
// Each event carries a compact delta (upserts/removedIds) rather than a full
// scene, so unlike the runtime track (one full snapshot per event) reconstructing
// the scene at an index requires folding every prior delta. That fold is
// precomputed once per `whiteboardEvents` array reference and cached (same
// technique as the preview track's `retainedStates`), so — after the first
// access — any seek is an O(1) lookup instead of O(events).
// ============================================================================

interface WhiteboardReplayIndex {
  retainedStates: WhiteboardSceneState[];
}

export interface WhiteboardReplayResult {
  nextIndex: number;
  stateToApply?: WhiteboardSceneState;
}

const whiteboardReplayIndexCache = new WeakMap<WhiteboardEvent[], WhiteboardReplayIndex>();

function applyWhiteboardEvent(
  state: WhiteboardSceneState,
  event: WhiteboardEvent,
): WhiteboardSceneState {
  let elements = state.elements;

  if (event.upserts?.length || event.removedIds?.length) {
    const byId = new Map(elements.map((element) => [element.id, element]));

    if (event.upserts) {
      for (const element of event.upserts) {
        byId.set(element.id, element);
      }
    }

    if (event.removedIds) {
      for (const id of event.removedIds) {
        byId.delete(id);
      }
    }

    elements = Array.from(byId.values());
  }

  return {
    elements,
    view: event.view ?? state.view,
    isOpen: event.isOpen ?? state.isOpen,
    isMaximized: event.isMaximized ?? state.isMaximized,
  };
}

function getWhiteboardReplayIndex(events: WhiteboardEvent[]): WhiteboardReplayIndex {
  const cached = whiteboardReplayIndexCache.get(events);

  if (cached) {
    return cached;
  }

  let state = EMPTY_WHITEBOARD_SCENE;
  const retainedStates: WhiteboardSceneState[] = [];

  for (const event of events) {
    state = applyWhiteboardEvent(state, event);
    retainedStates.push(state);
  }

  const replayIndex = { retainedStates };
  whiteboardReplayIndexCache.set(events, replayIndex);
  return replayIndex;
}

export function getWhiteboardReplayResult({
  whiteboardEvents,
  currentTime,
  lastAppliedIndex,
}: {
  whiteboardEvents: WhiteboardEvent[];
  currentTime: number;
  lastAppliedIndex: number;
}): WhiteboardReplayResult {
  const nextIndex = findTimedEventIndexAtOrBefore(whiteboardEvents, currentTime, lastAppliedIndex);

  if (nextIndex < 0 || nextIndex === lastAppliedIndex) {
    return { nextIndex };
  }

  return {
    nextIndex,
    stateToApply: getWhiteboardReplayIndex(whiteboardEvents).retainedStates[nextIndex],
  };
}

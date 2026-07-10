import {
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardElementJSON,
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

// Excalidraw z-orders elements by their fractional `index` field (lexicographic
// by design), but the fold below rebuilds the array in Map-insertion order —
// an upsert of an existing id keeps its original slot even when the change was
// a bring-to-front. Excalidraw's updateScene treats array order as the truth
// and rewrites disagreeing `index` fields (syncInvalidIndices), so the array
// must be sorted by `index` before it ever reaches updateScene.
function compareElementIndices(a: WhiteboardElementJSON, b: WhiteboardElementJSON): number {
  const aIndex = typeof a.index === "string" ? a.index : undefined;
  const bIndex = typeof b.index === "string" ? b.index : undefined;
  if (aIndex === undefined || bIndex === undefined || aIndex === bIndex) return 0;
  return aIndex < bIndex ? -1 : 1;
}

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

    elements = Array.from(byId.values()).sort(compareElementIndices);
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

  // Before the first event the board did not exist yet, so the empty scene is
  // the correct absolute state — without this, a backward seek (or replay
  // restart) to a time before the first event would leave the previously
  // applied scene on screen, since the SEEK reset makes `lastAppliedIndex`
  // equal to `nextIndex` (-1). EMPTY_WHITEBOARD_SCENE is a stable singleton,
  // so the store's reference-equality guard makes repeated applications free.
  if (nextIndex < 0) {
    return { nextIndex, stateToApply: EMPTY_WHITEBOARD_SCENE };
  }

  if (nextIndex === lastAppliedIndex) {
    return { nextIndex };
  }

  return {
    nextIndex,
    stateToApply: getWhiteboardReplayIndex(whiteboardEvents).retainedStates[nextIndex],
  };
}

import {
  applyWhiteboardEvent,
  compareWhiteboardElementIndices,
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
//
// On top of the exact per-event states, ticks that land *between* two events
// get an interpolated scene (see getInterpolatedState): freedraw strokes render
// a time-proportional prefix of the upcoming event's cumulative points, and
// moved/resized elements lerp their geometry. Capture flushes at ~100ms, but
// playback ticks at rAF rate — interpolation is what turns the 10Hz recorded
// steps back into a smooth hand-drawn motion without changing the file format.
// ============================================================================

interface WhiteboardReplayIndex {
  retainedStates: WhiteboardSceneState[];
}

export interface WhiteboardReplayResult {
  nextIndex: number;
  stateToApply?: WhiteboardSceneState;
}

const whiteboardReplayIndexCache = new WeakMap<WhiteboardEvent[], WhiteboardReplayIndex>();

/**
 * Folds events into retained scenes up to (and including) `throughIndex`.
 *
 * Only as far as the caller actually needs. This used to fold the *entire*
 * array on every call, regardless of where playback had reached, while keeping
 * every intermediate scene alive — and applyWhiteboardEvent allocates a fresh,
 * fully-sorted element array per event. A track of n events therefore retained
 * ~n²/2 element slots and performed n sorts before the first frame could be
 * shown. Nothing bounded n except the codec's million-record ceiling, so a
 * recording with tens of thousands of tiny events (a few hundred KB compressed)
 * hung the tab and then exhausted memory, on the main thread inside a state
 * machine action where it could not be interrupted.
 *
 * The fold is a pure prefix scan, so computing a prefix of it is exact — and
 * long legitimate recordings get the same win, since seeking near the start no
 * longer pays for the whole track.
 */
function getWhiteboardReplayIndex(
  events: WhiteboardEvent[],
  throughIndex: number,
): WhiteboardReplayIndex {
  let replayIndex = whiteboardReplayIndexCache.get(events);

  if (!replayIndex) {
    replayIndex = { retainedStates: [] };
    whiteboardReplayIndexCache.set(events, replayIndex);
  }

  // Streaming playback appends to this same array in place (APPEND_RECORDING_DELTA),
  // so the fold is *extended* rather than built once — a cache that stopped at the
  // pre-stream length would hand back `undefined` for every streamed-in index, which
  // freezes the board and crashes the interpolation path. The fold is a pure prefix
  // scan, so extending is exact. Same technique as `latestEditorModelBoundaryTime`.
  const { retainedStates } = replayIndex;
  const limit = Math.min(throughIndex, events.length - 1);
  for (let index = retainedStates.length; index <= limit; index += 1) {
    const base = index === 0 ? EMPTY_WHITEBOARD_SCENE : retainedStates[index - 1];
    retainedStates.push(applyWhiteboardEvent(base, events[index]));
  }

  return replayIndex;
}

// How far before an event's timestamp its changes start animating. Capture
// flushes every ~100ms while drawing, so during a continuous stroke the gap
// between events is about this size and the whole gap animates; after an idle
// pause only the tail of the gap does (the points were drawn just before the
// flush, not across the idle time).
const INTERPOLATION_WINDOW_MS = 150;

const lerp = (from: number, to: number, fraction: number) => from + (to - from) * fraction;

const LERPABLE_GEOMETRY_KEYS = ["x", "y", "width", "height", "angle"] as const;

/**
 * Builds the mid-transition version of one element: `base`'s discrete props
 * (color/text/isDeleted change only when their event actually applies) with
 * geometry lerped toward `target`, plus — for freedraw — a time-proportional
 * prefix of `target`'s cumulative points so the stroke draws point by point.
 * Returns null when there is nothing to animate. A brand-new element is only
 * pre-shown when it is a growing freedraw stroke; shapes pop in at their event
 * (they arrive small and then animate their drag-resize).
 */
function synthesizeInterpolatedElement(
  base: WhiteboardElementJSON | undefined,
  target: WhiteboardElementJSON,
  fraction: number,
): WhiteboardElementJSON | null {
  const targetPoints =
    target.type === "freedraw" && Array.isArray(target.points) ? target.points : null;

  if (!base && !targetPoints) {
    return null;
  }

  const synthesized: WhiteboardElementJSON = { ...(base ?? target) };
  let changed = !base;

  if (base) {
    for (const key of LERPABLE_GEOMETRY_KEYS) {
      const from = base[key];
      const to = target[key];
      if (typeof from === "number" && typeof to === "number" && from !== to) {
        synthesized[key] = lerp(from, to, fraction);
        changed = true;
      }
    }
  }

  if (targetPoints) {
    const fromCount = base && Array.isArray(base.points) ? base.points.length : 0;
    if (targetPoints.length > fromCount) {
      const count = Math.max(1, Math.round(lerp(fromCount, targetPoints.length, fraction)));
      synthesized.points = targetPoints.slice(0, count);
      // `pressures` parallels `points` on non-simulated-pressure strokes and
      // Excalidraw expects matching lengths.
      if (Array.isArray(target.pressures) && target.pressures.length === targetPoints.length) {
        synthesized.pressures = target.pressures.slice(0, count);
      }
      changed = true;
    }
  }

  return changed ? synthesized : null;
}

function getInterpolatedState(
  events: WhiteboardEvent[],
  nextIndex: number,
  currentTime: number,
): WhiteboardSceneState | undefined {
  const upcoming = events[nextIndex + 1];
  if (!upcoming?.upserts?.length) {
    return undefined;
  }

  const baseTimestamp = nextIndex >= 0 ? events[nextIndex].timestamp : Number.NEGATIVE_INFINITY;
  const windowStart = Math.max(baseTimestamp, upcoming.timestamp - INTERPOLATION_WINDOW_MS);
  if (currentTime <= windowStart || upcoming.timestamp <= windowStart) {
    return undefined;
  }

  const fraction = (currentTime - windowStart) / (upcoming.timestamp - windowStart);
  const baseState =
    nextIndex >= 0
      ? getWhiteboardReplayIndex(events, nextIndex).retainedStates[nextIndex]
      : EMPTY_WHITEBOARD_SCENE;
  const baseById = new Map(baseState.elements.map((element) => [element.id, element]));

  let elements: WhiteboardElementJSON[] | null = null;
  for (const target of upcoming.upserts) {
    const synthesized = synthesizeInterpolatedElement(baseById.get(target.id), target, fraction);
    if (!synthesized) continue;
    elements ??= [...baseState.elements];
    const existingIndex = elements.findIndex((element) => element.id === target.id);
    if (existingIndex >= 0) {
      elements[existingIndex] = synthesized;
    } else {
      elements.push(synthesized);
    }
  }

  if (!elements) {
    return undefined;
  }

  return { ...baseState, elements: elements.sort(compareWhiteboardElementIndices) };
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

  // A tick inside the animation window of the upcoming event renders the
  // in-between scene. This produces a fresh state object per tick on purpose —
  // the store must re-render for the stroke to animate; outside windows the
  // usual index short-circuits below keep ticks free.
  const interpolated = getInterpolatedState(whiteboardEvents, nextIndex, currentTime);
  if (interpolated) {
    return { nextIndex, stateToApply: interpolated };
  }

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
    stateToApply: getWhiteboardReplayIndex(whiteboardEvents, nextIndex).retainedStates[nextIndex],
  };
}

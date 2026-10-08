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
// the scene at an index requires folding every prior delta. Per
// `whiteboardEvents` array reference, the fold keeps a checkpoint scene every
// WHITEBOARD_SCENE_CHECKPOINT_INTERVAL events plus the scene it resolved last
// (see getWhiteboardSceneAt), so a seek within the part already folded applies
// at most the interval minus one events, and playback advancing one event
// applies one.
//
// On top of the exact per-event states, ticks that land *between* two events
// get an interpolated scene (see getInterpolatedState): freedraw strokes render
// a time-proportional prefix of the upcoming event's cumulative points, and
// moved/resized elements lerp their geometry. Capture flushes at ~100ms, but
// playback ticks at rAF rate — interpolation is what turns the 10Hz recorded
// steps back into a smooth hand-drawn motion without changing the file format.
// ============================================================================

/**
 * How often the fold keeps the scene it has reached. Retention is about one scene
 * per this many events, and a seek folds at most this many minus one events from
 * the nearest kept scene (about 2 ms at 300 elements).
 */
const WHITEBOARD_SCENE_CHECKPOINT_INTERVAL = 64;

interface WhiteboardReplayIndex {
  /** `checkpoints[k]` is the scene folded through index `(k + 1) * interval - 1`. */
  checkpoints: WhiteboardSceneState[];
  /** The scene resolved last, so ticks that stay on or advance from it fold little. */
  recent: { index: number; scene: WhiteboardSceneState } | null;
}

export interface WhiteboardReplayResult {
  nextIndex: number;
  stateToApply?: WhiteboardSceneState;
}

const whiteboardReplayIndexCache = new WeakMap<WhiteboardEvent[], WhiteboardReplayIndex>();

/**
 * The scene after folding events 0 through `index` (`0 <= index < events.length`).
 *
 * This used to fold the *entire* array on every call, regardless of where playback
 * had reached, while keeping every intermediate scene alive — and
 * applyWhiteboardEvent allocates a fresh, fully-sorted element array per event. A
 * track of n events therefore retained ~n²/2 element slots and performed n sorts
 * before the first frame could be shown. Nothing bounded n except the codec's
 * million-record ceiling, so a recording with tens of thousands of tiny events (a
 * few hundred KB compressed) hung the tab and then exhausted memory, on the main
 * thread inside a state machine action where it could not be interrupted.
 *
 * 35204cca bounded the fold to the requested index, but still kept one scene per
 * event up to it, so a seek near the end of a long track retained the same ~n²/2
 * slots (36 MB for 10,000 events over 300 elements, 505 MB for 10,000 events that
 * each add an element). Now only every WHITEBOARD_SCENE_CHECKPOINT_INTERVAL-th scene is kept,
 * plus the last one resolved. The first fold to a far index still applies every
 * event before it once.
 *
 * The fold is a pure prefix scan, so starting from a kept scene is exact, and so is
 * extending it: streaming playback appends to this same array in place
 * (APPEND_RECORDING_DELTA), and the checkpoints only ever cover decoded events.
 */
function getWhiteboardSceneAt(events: WhiteboardEvent[], index: number): WhiteboardSceneState {
  let replayIndex = whiteboardReplayIndexCache.get(events);

  if (!replayIndex) {
    replayIndex = { checkpoints: [], recent: null };
    whiteboardReplayIndexCache.set(events, replayIndex);
  }

  const { checkpoints, recent } = replayIndex;
  if (recent?.index === index) {
    return recent.scene;
  }

  // Start from the last kept checkpoint at or before `index` (none: the empty
  // scene), or from the recent scene when it lies between that checkpoint and `index`.
  const interval = WHITEBOARD_SCENE_CHECKPOINT_INTERVAL;
  const slot = Math.min(Math.floor((index + 1) / interval), checkpoints.length) - 1;
  let start = (slot + 1) * interval - 1;
  let scene = slot >= 0 ? checkpoints[slot] : EMPTY_WHITEBOARD_SCENE;
  if (recent && recent.index > start && recent.index < index) {
    start = recent.index;
    scene = recent.scene;
  }

  // Every checkpoint at or before an index already resolved is kept, so the fold
  // meets the missing ones in order and keeps each as it passes it.
  for (let cursor = start + 1; cursor <= index; cursor += 1) {
    scene = applyWhiteboardEvent(scene, events[cursor]);
    if (cursor + 1 === (checkpoints.length + 1) * interval) {
      checkpoints.push(scene);
    }
  }

  replayIndex.recent = { index, scene };
  return scene;
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
    nextIndex >= 0 ? getWhiteboardSceneAt(events, nextIndex) : EMPTY_WHITEBOARD_SCENE;
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
    stateToApply: getWhiteboardSceneAt(whiteboardEvents, nextIndex),
  };
}

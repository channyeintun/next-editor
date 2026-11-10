import {
  compareWhiteboardElementIndices,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../../whiteboard";
import { findTimedEventIndexAtOrBefore } from "../../utils/timedIndex";
import { createViewChangeResolver } from "./viewChanges";
import { createWhiteboardSceneFold, type WhiteboardSceneFold } from "./whiteboardSceneFold";

// ============================================================================
// Whiteboard track replay.
//
// Each event carries a compact delta (upserts/removedIds) rather than a full
// scene, so unlike the runtime track (one full snapshot per event) reconstructing
// the scene at an index requires folding every prior delta. Per
// `whiteboardEvents` array reference, the fold keeps checkpoint scenes along the
// track plus the scene it resolved last (see getWhiteboardSceneAt), so a seek
// within the part already folded starts from the nearest checkpoint, and playback
// advancing one event applies one.
//
// On top of the exact per-event states, ticks that land *between* two events
// get an interpolated scene (see getInterpolatedState): freedraw strokes render
// a time-proportional prefix of the upcoming event's cumulative points, and
// moved/resized elements lerp their geometry. Capture flushes at ~100ms, but
// playback ticks at rAF rate — interpolation is what turns the 10Hz recorded
// steps back into a smooth hand-drawn motion without changing the file format.
// ============================================================================

/**
 * The fewest events between two kept scenes. A scene is also kept only once the
 * events since the last one did as much work as it has elements (see
 * {@link whiteboardEventWork}). So the scenes kept for a track hold no more element
 * slots than the track has events and changes, and a seek folds, from the nearest
 * kept scene, fewer than this many events or less work than the scene it lands on
 * has elements. A track of small events over a small scene keeps one scene every
 * this many events.
 */
const WHITEBOARD_SCENE_CHECKPOINT_INTERVAL = 64;

interface WhiteboardSceneCheckpoint {
  /** The index of the event `scene` is folded through. */
  index: number;
  scene: WhiteboardSceneState;
}

interface WhiteboardReplayIndex {
  /** The kept scenes, in index order. */
  checkpoints: WhiteboardSceneCheckpoint[];
  /** The last index a fold has reached. Every checkpoint is at or before it. */
  foldedThrough: number;
  /** The work of the events after the last checkpoint, through `foldedThrough`. */
  workSinceCheckpoint: number;
  /**
   * The scene resolved last, and the fold that stands at it, so ticks that stay on it
   * are free and ticks that advance from it apply only the events they cross.
   */
  recent: { index: number; scene: WhiteboardSceneState; fold: WhiteboardSceneFold } | null;
}

export interface WhiteboardReplayResult {
  nextIndex: number;
  stateToApply?: WhiteboardSceneState;
}

const whiteboardReplayIndexCache = new WeakMap<WhiteboardEvent[], WhiteboardReplayIndex>();

/** What folding `event` costs: one step, and one per element it upserts or removes. */
function whiteboardEventWork(event: WhiteboardEvent): number {
  return 1 + (event.upserts?.length ?? 0) + (event.removedIds?.length ?? 0);
}

/** The last kept scene at or before `index`, if any. `checkpoints` is in index order. */
function findCheckpointAtOrBefore(
  checkpoints: WhiteboardSceneCheckpoint[],
  index: number,
): WhiteboardSceneCheckpoint | undefined {
  let low = 0;
  let high = checkpoints.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (checkpoints[middle].index <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return checkpoints[high];
}

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
 * 35204cca bounded the fold to the requested index, and 0e176f8a kept only every
 * 64th scene. Both still built a sorted scene for every event they folded, so a
 * tick or a seek across n events over a scene of E elements cost n × E (a million
 * one-element events over a few thousand elements is a frozen tab), and the kept
 * scenes held (n / 64) × E slots. Now the events are folded into one working scene
 * (see whiteboardSceneFold.ts), a sorted scene is built only for a checkpoint and
 * for the index asked for, and checkpoints are spaced by the work between them. A
 * fold costs about the changes it crosses plus the scene it ends on.
 *
 * The fold is a pure prefix scan, so starting from a kept scene is exact, and so is
 * extending it: streaming playback appends to this same array in place
 * (APPEND_RECORDING_DELTA), and the checkpoints only ever cover decoded events.
 */
function getWhiteboardSceneAt(events: WhiteboardEvent[], index: number): WhiteboardSceneState {
  let replayIndex = whiteboardReplayIndexCache.get(events);

  if (!replayIndex) {
    replayIndex = { checkpoints: [], foldedThrough: -1, workSinceCheckpoint: 0, recent: null };
    whiteboardReplayIndexCache.set(events, replayIndex);
  }

  const { checkpoints, recent } = replayIndex;
  if (recent?.index === index) {
    return recent.scene;
  }

  // Start from the last kept checkpoint at or before `index` (none: the empty
  // scene), or from the recent scene when it lies between that checkpoint and `index`.
  const checkpoint = findCheckpointAtOrBefore(checkpoints, index);
  if (checkpoint?.index === index) {
    replayIndex.recent = { ...checkpoint, fold: createWhiteboardSceneFold(checkpoint.scene) };
    return checkpoint.scene;
  }
  let start = checkpoint?.index ?? -1;
  let fold: WhiteboardSceneFold;
  if (recent && recent.index > start && recent.index < index) {
    start = recent.index;
    fold = recent.fold;
    // The fold leaves `recent.index` below. An event that throws must not leave it
    // recorded there, half applied.
    replayIndex.recent = null;
  } else {
    fold = createWhiteboardSceneFold(checkpoint?.scene ?? EMPTY_WHITEBOARD_SCENE);
  }

  // Every index up to `foldedThrough` has had its chance to become a checkpoint, so
  // a fold keeps new ones only past it, where it meets the events in order.
  let scene: WhiteboardSceneState | undefined;
  for (let cursor = start + 1; cursor <= index; cursor += 1) {
    fold.apply(events[cursor]);
    scene = undefined;
    if (cursor <= replayIndex.foldedThrough) {
      continue;
    }
    replayIndex.foldedThrough = cursor;
    replayIndex.workSinceCheckpoint += whiteboardEventWork(events[cursor]);
    if (
      cursor - (checkpoints.at(-1)?.index ?? -1) >= WHITEBOARD_SCENE_CHECKPOINT_INTERVAL &&
      replayIndex.workSinceCheckpoint >= fold.size()
    ) {
      scene = fold.scene();
      checkpoints.push({ index: cursor, scene });
      replayIndex.workSinceCheckpoint = 0;
    }
  }

  scene ??= fold.scene();
  replayIndex.recent = { index, scene, fold };
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
  // Where each element is in `elements`: the base scene's, then the ones pushed below.
  // Searching the array for each upsert cost upserts x elements on every frame of the
  // window, and a lesson file sets both.
  const baseElements = baseState.elements;
  const positionById = new Map(baseElements.map((element, position) => [element.id, position]));

  let elements: WhiteboardElementJSON[] | null = null;
  for (const target of upcoming.upserts) {
    const position = positionById.get(target.id);
    // A pushed element is not in the base scene: its upsert was repeated in this event.
    const base =
      position !== undefined && position < baseElements.length ? baseElements[position] : undefined;
    const synthesized = synthesizeInterpolatedElement(base, target, fraction);
    if (!synthesized) continue;
    elements ??= [...baseElements];
    if (position !== undefined) {
      elements[position] = synthesized;
    } else {
      positionById.set(target.id, elements.length);
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

/** How the board is shown: the part of the scene a viewer may change while a lesson plays. */
export type WhiteboardPanelView = Pick<WhiteboardSceneState, "isOpen" | "isMaximized">;

const sameWhiteboardView = (left: WhiteboardPanelView, right: WhiteboardPanelView) =>
  left.isOpen === right.isOpen && left.isMaximized === right.isMaximized;

/**
 * The latest whiteboard event at or before `index` that opened, closed, maximized or
 * restored the board, or -1. An event carries `isOpen`/`isMaximized` only when it set them,
 * and one that sets them to what they already were changes nothing.
 */
export const getWhiteboardViewChangeIndex = createViewChangeResolver<
  WhiteboardEvent,
  WhiteboardPanelView
>({
  initial: {
    isOpen: EMPTY_WHITEBOARD_SCENE.isOpen,
    isMaximized: EMPTY_WHITEBOARD_SCENE.isMaximized,
  },
  next: (view, event) =>
    event.isOpen === undefined && event.isMaximized === undefined
      ? view
      : {
          isOpen: event.isOpen ?? view.isOpen,
          isMaximized: event.isMaximized ?? view.isMaximized,
        },
  isSameView: sameWhiteboardView,
});

const scenesShownTheViewersWay = new WeakMap<WhiteboardSceneState, WhiteboardSceneState>();

/**
 * `scene` with the board shown as `view` has it. The same object for the same scene and
 * view, so a tick that re-applies an unchanged scene (the empty board before the first
 * event is applied on every tick) still leaves the store alone.
 */
export function withWhiteboardView(
  scene: WhiteboardSceneState,
  view: WhiteboardPanelView,
): WhiteboardSceneState {
  if (sameWhiteboardView(scene, view)) {
    return scene;
  }

  const shown = scenesShownTheViewersWay.get(scene);
  if (shown && sameWhiteboardView(shown, view)) {
    return shown;
  }

  const next = { ...scene, isOpen: view.isOpen, isMaximized: view.isMaximized };
  scenesShownTheViewersWay.set(scene, next);
  return next;
}

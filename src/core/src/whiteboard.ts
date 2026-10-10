/**
 * Structural copy of the fields of an Excalidraw scene element this engine cares
 * about for diffing. The core package does not depend on @excalidraw/excalidraw
 * (kept UI-library-free like the rest of core/src) — elements are carried as
 * opaque JSON beyond `id`/`version`/`versionNonce`/`isDeleted`, the same way
 * {@link PreviewRecordedEvent} carries rrweb events verbatim.
 */
export interface WhiteboardElementJSON {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  [key: string]: unknown;
}

export interface WhiteboardView {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/**
 * One recorded whiteboard change. Elements are recorded as compact deltas — only
 * what changed since the previous event — never a full-array snapshot; see
 * {@link deriveWhiteboardDelta}. `view`/`isOpen`/`isMaximized` are only present
 * when they changed, the same convention the workspace/preview event tracks use.
 */
export interface WhiteboardEvent {
  timestamp: number;
  /** New or changed elements (matched by id+version). A soft delete — `isDeleted: true` — is just another upsert. */
  upserts?: WhiteboardElementJSON[];
  /** Ids that vanished from the scene entirely (hard removal, distinct from a soft-deleted upsert). */
  removedIds?: string[];
  view?: WhiteboardView;
  isOpen?: boolean;
  isMaximized?: boolean;
}

/** Reconstructed whiteboard state at some point in time. */
export interface WhiteboardSceneState {
  elements: WhiteboardElementJSON[];
  view: WhiteboardView;
  isOpen: boolean;
  isMaximized: boolean;
}

// Shared reference sentinels: every store and replay state starts from these,
// and replay compares the scene by identity. Frozen so a stray write throws at
// its source instead of changing every later empty scene.
export const DEFAULT_WHITEBOARD_VIEW: WhiteboardView = Object.freeze({
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
});

export const EMPTY_WHITEBOARD_SCENE: WhiteboardSceneState = Object.freeze({
  elements: Object.freeze<WhiteboardElementJSON[]>([]) as WhiteboardElementJSON[],
  view: DEFAULT_WHITEBOARD_VIEW,
  isOpen: false,
  isMaximized: false,
});

// Serialized form of elements on the *previous* side of a diff. That side is
// always an immutable snapshot — snapshotWhiteboardDelta's clones in the store,
// markCanvasSynced's copies, a parsed room projection; Excalidraw only ever gets
// copies (WhiteboardPanel) — so an element's JSON never changes once computed.
// Unchanged elements reach the JSON compare on every 100 ms capture flush, and
// this serializes each of them once instead of once per flush. The live side
// is never cached: Excalidraw mutates those objects in place.
const previousElementJson = new WeakMap<WhiteboardElementJSON, string>();

function previousElementJsonOf(element: WhiteboardElementJSON): string {
  let json = previousElementJson.get(element);
  if (json === undefined) {
    json = JSON.stringify(element);
    previousElementJson.set(element, json);
  }
  return json;
}

/**
 * Diffs the previous captured elements array against the current one and returns
 * only what changed: `upserts` for new/changed elements (matched by `id`,
 * `version`, `versionNonce`, and serialized JSON) and `removedIds` for ids that
 * vanished from the array entirely.
 * Pure and O(elements) — the caller keeps `previousElements` itself (see the
 * whiteboard store's capture path) and passes the latest array on every change.
 * `previousElements` must be snapshots nothing mutates afterwards (their JSON
 * is cached by object); `elements` may be Excalidraw's live objects.
 */
export function deriveWhiteboardDelta(
  previousElements: readonly WhiteboardElementJSON[],
  elements: readonly WhiteboardElementJSON[],
): { upserts: WhiteboardElementJSON[]; removedIds: string[] } {
  const previousById = new Map<string, WhiteboardElementJSON>();
  for (const element of previousElements) {
    previousById.set(element.id, element);
  }

  const upserts: WhiteboardElementJSON[] = [];
  const seenIds = new Set<string>();

  for (const element of elements) {
    seenIds.add(element.id);
    const previous = previousById.get(element.id);
    if (
      !previous ||
      (previous !== element &&
        (previous.version !== element.version ||
          previous.versionNonce !== element.versionNonce ||
          previousElementJsonOf(previous) !== JSON.stringify(element)))
    ) {
      upserts.push(element);
    }
  }

  const removedIds: string[] = [];
  for (const id of previousById.keys()) {
    if (!seenIds.has(id)) {
      removedIds.push(id);
    }
  }

  return { upserts, removedIds };
}

/**
 * Applies a locally derived delta to a newer scene without removing elements
 * that arrived after the local capture window began. The newer scene is a room
 * update that landed mid-window, so the result follows the room's order
 * ({@link compareWhiteboardElementOrder}), not replay's: tied elements then
 * already sit where the room's projection puts them, instead of flipping when
 * the room's scene comes back.
 *
 * `delta` must come from {@link deriveWhiteboardDelta} (or
 * {@link snapshotWhiteboardDelta}), where no id is in both `upserts` and
 * `removedIds`. The shared merge upserts before it removes, which gives the
 * same result as removing first only under that precondition.
 */
export function rebaseWhiteboardDelta(
  currentElements: readonly WhiteboardElementJSON[],
  delta: Pick<WhiteboardEvent, "upserts" | "removedIds">,
): WhiteboardElementJSON[] {
  return mergeWhiteboardElements(currentElements, delta, compareWhiteboardElementOrder);
}

/**
 * Like {@link deriveWhiteboardDelta}, but returns *snapshots*: Excalidraw
 * mutates its element objects in place while the user draws (`points` grows and
 * `version` bumps on every pointermove), so holding live references would make
 * the next diff compare an element's version against itself — nothing past an
 * element's first appearance would ever record — and every recorded upsert
 * would silently drift to the element's final state by encode time, making
 * strokes pop in fully drawn on replay instead of animating.
 *
 * Returns `null` when no element changed. `nextElements` is the caller's new
 * "previous" array: cloned upserts merged with the prior snapshots, in the live
 * array's order (Excalidraw's array order is z-order, so it must be preserved).
 */
export function snapshotWhiteboardDelta(
  previousElements: readonly WhiteboardElementJSON[],
  liveElements: readonly WhiteboardElementJSON[],
): {
  upserts: WhiteboardElementJSON[];
  removedIds: string[];
  nextElements: WhiteboardElementJSON[];
} | null {
  const { upserts, removedIds } = deriveWhiteboardDelta(previousElements, liveElements);

  if (!upserts.length && !removedIds.length) {
    return null;
  }

  const clonedById = new Map(
    upserts.map((element) => [element.id, structuredClone(element)] as const),
  );
  const previousById = new Map(previousElements.map((element) => [element.id, element]));

  return {
    upserts: Array.from(clonedById.values()),
    removedIds,
    nextElements: liveElements.map(
      (element) =>
        clonedById.get(element.id) ?? previousById.get(element.id) ?? structuredClone(element),
    ),
  };
}

export function areWhiteboardViewsEqual(
  a: WhiteboardView | undefined,
  b: WhiteboardView | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom;
}

/**
 * Excalidraw z-orders elements by their fractional `index` field (lexicographic
 * by design), but a Map-based upsert rebuilds the array in insertion order — an
 * upsert of an existing id keeps its original slot even when the change was a
 * bring-to-front. Excalidraw's updateScene treats array order as the truth and
 * rewrites disagreeing `index` fields (syncInvalidIndices), so the array must be
 * sorted by `index` before it ever reaches updateScene.
 *
 * An element without an index (an authored asset) sorts as `""`, below every
 * indexed one. Treating it as equal to everything instead is not a consistent
 * order, and the sort then left the indexed elements around it unsorted. Ties
 * return 0, so a stable sort keeps unindexed elements in their array order.
 */
export function compareWhiteboardElementIndices(
  a: WhiteboardElementJSON,
  b: WhiteboardElementJSON,
): number {
  const aIndex = typeof a.index === "string" ? a.index : "";
  const bIndex = typeof b.index === "string" ? b.index : "";
  return aIndex < bIndex ? -1 : aIndex > bIndex ? 1 : 0;
}

/**
 * The collaboration room's canonical scene order: fractional `index`, then the
 * element id for ties. Merges that must converge with a room sort with this
 * (teachingWhiteboard's projection, {@link rebaseWhiteboardDelta}). Replay and the
 * studio driver keep {@link compareWhiteboardElementIndices}, because a stable
 * sort over its ties is the only z-order unindexed authored assets have.
 */
export function compareWhiteboardElementOrder(
  a: WhiteboardElementJSON,
  b: WhiteboardElementJSON,
): number {
  return compareWhiteboardElementIndices(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Upserts then removes by id, and sorts the result with the consumer's `compare`. */
function mergeWhiteboardElements(
  elements: readonly WhiteboardElementJSON[],
  delta: Pick<WhiteboardEvent, "upserts" | "removedIds">,
  compare: (a: WhiteboardElementJSON, b: WhiteboardElementJSON) => number,
): WhiteboardElementJSON[] {
  const byId = new Map(elements.map((element) => [element.id, element] as const));
  for (const element of delta.upserts ?? []) byId.set(element.id, element);
  for (const id of delta.removedIds ?? []) byId.delete(id);
  return Array.from(byId.values()).sort(compare);
}

/**
 * Fold one whiteboard delta into a scene. Shared by replay (replayState/whiteboard.ts)
 * and by the studio driver, which publishes the same delta to the live board — if the
 * two disagreed about element order, a lesson would render one z-order live and a
 * different one on replay, since `index` is absent on authored assets and array order
 * is then all Excalidraw has to go on.
 */
export function applyWhiteboardEvent(
  state: WhiteboardSceneState,
  event: WhiteboardEvent,
): WhiteboardSceneState {
  let elements = state.elements;

  if (event.upserts?.length || event.removedIds?.length) {
    elements = mergeWhiteboardElements(elements, event, compareWhiteboardElementIndices);
  }

  return {
    elements,
    view: event.view ?? state.view,
    isOpen: event.isOpen ?? state.isOpen,
    isMaximized: event.isMaximized ?? state.isMaximized,
  };
}

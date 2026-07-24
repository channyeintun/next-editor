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

export const DEFAULT_WHITEBOARD_VIEW: WhiteboardView = { scrollX: 0, scrollY: 0, zoom: 1 };

export const EMPTY_WHITEBOARD_SCENE: WhiteboardSceneState = {
  elements: [],
  view: DEFAULT_WHITEBOARD_VIEW,
  isOpen: false,
  isMaximized: false,
};

/**
 * Diffs the previous captured elements array against the current one and returns
 * only what changed: `upserts` for new/changed elements (matched by `id`,
 * `version`, `versionNonce`, and serialized JSON) and `removedIds` for ids that
 * vanished from the array entirely.
 * Pure and O(elements) — the caller keeps `previousElements` itself (see the
 * whiteboard store's capture path) and passes the latest array on every change.
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
      previous.version !== element.version ||
      previous.versionNonce !== element.versionNonce ||
      JSON.stringify(previous) !== JSON.stringify(element)
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

/** Applies a locally derived delta to a newer scene without removing elements
 * that arrived after the local capture window began. */
export function rebaseWhiteboardDelta(
  currentElements: readonly WhiteboardElementJSON[],
  delta: Pick<WhiteboardEvent, "upserts" | "removedIds">,
): WhiteboardElementJSON[] {
  const removed = new Set(delta.removedIds ?? []);
  const byId = new Map(
    currentElements
      .filter((element) => !removed.has(element.id))
      .map((element) => [element.id, element] as const),
  );
  for (const element of delta.upserts ?? []) byId.set(element.id, element);
  return Array.from(byId.values()).sort((left, right) => {
    const leftIndex = typeof left.index === "string" ? left.index : "";
    const rightIndex = typeof right.index === "string" ? right.index : "";
    return leftIndex < rightIndex
      ? -1
      : leftIndex > rightIndex
        ? 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0;
  });
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
 */
export function compareWhiteboardElementIndices(
  a: WhiteboardElementJSON,
  b: WhiteboardElementJSON,
): number {
  const aIndex = typeof a.index === "string" ? a.index : undefined;
  const bIndex = typeof b.index === "string" ? b.index : undefined;
  if (aIndex === undefined || bIndex === undefined || aIndex === bIndex) return 0;
  return aIndex < bIndex ? -1 : 1;
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

    elements = Array.from(byId.values()).sort(compareWhiteboardElementIndices);
  }

  return {
    elements,
    view: event.view ?? state.view,
    isOpen: event.isOpen ?? state.isOpen,
    isMaximized: event.isMaximized ?? state.isMaximized,
  };
}

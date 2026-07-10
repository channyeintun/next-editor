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
 * only what changed: `upserts` for new/changed elements (matched by `id` +
 * `version`) and `removedIds` for ids that vanished from the array entirely.
 * Pure and O(elements) — the caller keeps `previousElements` itself (see the
 * whiteboard store's capture path) and passes the latest array on every change.
 */
export function deriveWhiteboardDelta(
  previousElements: readonly WhiteboardElementJSON[],
  elements: readonly WhiteboardElementJSON[],
): { upserts: WhiteboardElementJSON[]; removedIds: string[] } {
  const previousVersions = new Map<string, number>();
  for (const element of previousElements) {
    previousVersions.set(element.id, element.version);
  }

  const upserts: WhiteboardElementJSON[] = [];
  const seenIds = new Set<string>();

  for (const element of elements) {
    seenIds.add(element.id);
    if (previousVersions.get(element.id) !== element.version) {
      upserts.push(element);
    }
  }

  const removedIds: string[] = [];
  for (const id of previousVersions.keys()) {
    if (!seenIds.has(id)) {
      removedIds.push(id);
    }
  }

  return { upserts, removedIds };
}

export function areWhiteboardViewsEqual(
  a: WhiteboardView | undefined,
  b: WhiteboardView | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom;
}

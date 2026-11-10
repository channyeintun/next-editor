import {
  compareWhiteboardElementIndices,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../../whiteboard";

// ============================================================================
// Folding a run of whiteboard events into a scene.
//
// `applyWhiteboardEvent` (core/whiteboard.ts) is the rule: upsert by id, remove by
// id, then sort by fractional `index`, stably, so elements with the same index (or
// none: authored assets) keep the order the scene before the event had them in,
// with new ids after them. It builds a whole scene per event: a Map of every
// element, an array copy and a sort. Folding n events over a scene of E elements
// that way costs n × E, and a lesson file sets both.
//
// This folds the same run with work proportional to what the events change, and
// builds the sorted array only when a scene is asked for. Sorting once at the end
// is not the same rule by itself: where an element with a changed index lands among
// its ties depends on the order the scenes in between had. So each element carries
// a rank that stands for its place in the scene before the event, and a scene is
// the elements sorted by index, then rank:
//
//   * an element whose index is unchanged keeps its rank;
//   * one that moves to a higher index came from before every element already
//     there, so it takes a rank below every rank in use;
//   * one that moves to a lower index came from after them, so it takes a rank
//     above every rank in use;
//   * a new id goes last, above those;
//   * elements that move the same way in one event keep the order they had.
//
// whiteboardSceneFold.test.ts checks the result against `applyWhiteboardEvent`
// event by event.
// ============================================================================

interface Slot {
  element: WhiteboardElementJSON;
  rank: number;
}

export interface WhiteboardSceneFold {
  /** Folds one more event into the scene. */
  apply(event: WhiteboardEvent): void;
  /** How many elements the scene has now. */
  size(): number;
  /** The scene now, as folding the same events with `applyWhiteboardEvent` gives it. */
  scene(): WhiteboardSceneState;
}

const compareSlots = (a: Slot, b: Slot) =>
  compareWhiteboardElementIndices(a.element, b.element) || a.rank - b.rank;

/** A fold that starts from `start`, which it never changes. */
export function createWhiteboardSceneFold(start: WhiteboardSceneState): WhiteboardSceneFold {
  let { view, isOpen, isMaximized } = start;
  // The sorted elements, while no event has changed them since they were built.
  let elements: WhiteboardElementJSON[] | null = start.elements;
  // Built from `elements` by the first event that changes them.
  let slots: Map<WhiteboardElementJSON["id"], Slot> | null = null;
  // The slots in scene order, while no event has added, removed or moved one since
  // they were sorted. Most events only redraw elements where they are (a stroke
  // growing, a shape dragged), and the next scene then needs no sort.
  let order: Slot[] | null = null;
  // Ranks in use lie strictly between these.
  let rankBelow = -1;
  let rankAbove = 0;

  function slotsOf(sorted: WhiteboardElementJSON[]): Map<WhiteboardElementJSON["id"], Slot> {
    const byId = new Map<WhiteboardElementJSON["id"], Slot>();
    for (let rank = 0; rank < sorted.length; rank += 1) {
      byId.set(sorted[rank].id, { element: sorted[rank], rank });
    }
    rankBelow = -1;
    rankAbove = sorted.length;
    return byId;
  }

  function mergeElements(event: WhiteboardEvent, byId: Map<WhiteboardElementJSON["id"], Slot>) {
    // The elements this event replaces, as they were before it, and the ids it adds.
    let replaced: Map<Slot, WhiteboardElementJSON> | null = null;
    let added: Set<Slot> | null = null;

    for (const element of event.upserts ?? []) {
      const slot = byId.get(element.id);
      if (!slot) {
        const created: Slot = { element, rank: 0 };
        byId.set(element.id, created);
        (added ??= new Set()).add(created);
        continue;
      }
      if (!added?.has(slot) && !replaced?.has(slot)) {
        (replaced ??= new Map()).set(slot, slot.element);
      }
      slot.element = element;
    }
    for (const id of event.removedIds ?? []) {
      if (byId.delete(id)) {
        order = null;
      }
    }

    if (replaced) {
      const before = replaced;
      const raised: Slot[] = [];
      const lowered: Slot[] = [];
      for (const [slot, previous] of before) {
        const direction = compareWhiteboardElementIndices(previous, slot.element);
        if (direction < 0) raised.push(slot);
        else if (direction > 0) lowered.push(slot);
      }
      const byPlaceBefore = (a: Slot, b: Slot) =>
        compareWhiteboardElementIndices(before.get(a)!, before.get(b)!) || a.rank - b.rank;
      if (raised.length || lowered.length) {
        order = null;
      }
      // Both sorts read ranks, so they run before either group takes new ones.
      raised.sort(byPlaceBefore);
      lowered.sort(byPlaceBefore);
      for (let index = raised.length - 1; index >= 0; index -= 1) {
        raised[index].rank = rankBelow;
        rankBelow -= 1;
      }
      for (const slot of lowered) {
        slot.rank = rankAbove;
        rankAbove += 1;
      }
    }
    if (added) {
      order = null;
      for (const slot of added) {
        slot.rank = rankAbove;
        rankAbove += 1;
      }
    }
  }

  return {
    apply(event) {
      // The same test as applyWhiteboardEvent: a delta that names nothing keeps the array.
      if (event.upserts?.length || event.removedIds?.length) {
        slots ??= slotsOf(elements ?? []);
        elements = null;
        mergeElements(event, slots);
      }
      view = event.view ?? view;
      isOpen = event.isOpen ?? isOpen;
      isMaximized = event.isMaximized ?? isMaximized;
    },
    size: () => slots?.size ?? elements?.length ?? 0,
    scene() {
      if (!elements) {
        order ??= Array.from(slots?.values() ?? []).sort(compareSlots);
        elements = order.map((slot) => slot.element);
      }
      return { elements, view, isOpen, isMaximized };
    },
  };
}

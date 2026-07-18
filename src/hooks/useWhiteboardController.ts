import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import {
  areWhiteboardViewsEqual,
  rebaseWhiteboardDelta,
  snapshotWhiteboardDelta,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardView,
} from "../core/src/whiteboard";
import { selectScene, type WhiteboardStoreInstance } from "../stores/whiteboardStore";

interface UseWhiteboardControllerConfig {
  store: WhiteboardStoreInstance;
  onWhiteboardEvent?: (event: WhiteboardEvent) => boolean | void;
  scopeKey?: unknown;
}

interface PendingWhiteboardController {
  flush: () => void;
  discard: () => void;
}

const pendingWhiteboardControllers = new WeakMap<
  WhiteboardStoreInstance,
  PendingWhiteboardController
>();

export function flushPendingWhiteboardChange(store: WhiteboardStoreInstance): void {
  pendingWhiteboardControllers.get(store)?.flush();
}

export function discardPendingWhiteboardChange(store: WhiteboardStoreInstance): void {
  pendingWhiteboardControllers.get(store)?.discard();
}

// Coalesces rapid onChange fires while a stroke is being drawn into one recorded
// event per window — the freehand element's `points` array keeps growing across
// those fires, so the coalesced upsert still captures progressive drawing.
const CHANGE_THROTTLE_MS = 100;

/**
 * Bridges a mounted Excalidraw instance to the whiteboard store and the
 * recorder. One instance is shared (via WhiteboardProvider) by every consumer —
 * the panel (for onChange) and any toolbar toggle (for isOpen) — so the
 * diff/throttle state below stays singleton, matching useSlidesController.
 *
 * Read-only/replay gating is NOT tracked here: the caller (WhiteboardPanel) passes
 * `isContentReadOnly` fresh on every call, driven by playback or room role
 * `usesPlaybackModel` state. That state already flips back to `false` the instant
 * playback stops, recording starts, or the recording unloads — mirroring it in a
 * separate store field would need the same resets duplicated and re-verified here.
 */
export const useWhiteboardController = ({
  store,
  onWhiteboardEvent,
  scopeKey,
}: UseWhiteboardControllerConfig) => {
  const scene = useSelector(store, (snapshot) => selectScene(snapshot.context));

  const onWhiteboardEventRef = useRef(onWhiteboardEvent);
  useEffect(() => {
    onWhiteboardEventRef.current = onWhiteboardEvent;
  }, [onWhiteboardEvent]);

  const throttleTimeoutRef = useRef<number | null>(null);
  const pendingElementsRef = useRef<readonly WhiteboardElementJSON[] | null>(null);
  const pendingBaseElementsRef = useRef<readonly WhiteboardElementJSON[] | null>(null);
  const pendingViewRef = useRef<WhiteboardView | undefined>(undefined);

  const discardPendingChange = useCallback(() => {
    if (throttleTimeoutRef.current !== null) {
      window.clearTimeout(throttleTimeoutRef.current);
    }
    throttleTimeoutRef.current = null;
    pendingElementsRef.current = null;
    pendingBaseElementsRef.current = null;
    pendingViewRef.current = undefined;
  }, []);

  const flushPendingChange = useCallback(() => {
    if (throttleTimeoutRef.current !== null) {
      window.clearTimeout(throttleTimeoutRef.current);
    }
    throttleTimeoutRef.current = null;
    const elements = pendingElementsRef.current;
    pendingElementsRef.current = null;
    const baseElements = pendingBaseElementsRef.current;
    pendingBaseElementsRef.current = null;
    const view = pendingViewRef.current;
    pendingViewRef.current = undefined;
    if (!elements) return;

    const current = store.getSnapshot().context.scene;
    // Snapshots, not live references: Excalidraw mutates elements in place while
    // drawing, so the store must hold clones for the diff (and the recorded
    // upserts) to see each flush's intermediate state — that per-flush growth of
    // a stroke's points is what makes it animate on replay.
    const snapshot = snapshotWhiteboardDelta(baseElements ?? current.elements, elements);
    const viewChanged = Boolean(view) && !areWhiteboardViewsEqual(view, current.view);

    if (!snapshot && !viewChanged) {
      return;
    }

    const event: WhiteboardEvent = {
      timestamp: performance.now(),
      ...(snapshot?.upserts.length ? { upserts: snapshot.upserts } : {}),
      ...(snapshot?.removedIds.length ? { removedIds: snapshot.removedIds } : {}),
      ...(viewChanged ? { view } : {}),
    };
    const accepted = onWhiteboardEventRef.current?.(event) !== false;
    store.trigger.setScene({
      scene: {
        elements: accepted
          ? snapshot
            ? baseElements === current.elements
              ? snapshot.nextElements
              : rebaseWhiteboardDelta(current.elements, snapshot)
            : current.elements
          : structuredClone(current.elements),
        view: viewChanged && view ? view : current.view,
        isOpen: current.isOpen,
        isMaximized: current.isMaximized,
      },
    });
  }, [store]);

  useLayoutEffect(() => {
    const controller = { flush: flushPendingChange, discard: discardPendingChange };
    pendingWhiteboardControllers.set(store, controller);
    return () => {
      if (pendingWhiteboardControllers.get(store) === controller) {
        pendingWhiteboardControllers.delete(store);
      }
    };
  }, [discardPendingChange, flushPendingChange, store]);

  useLayoutEffect(
    () => () => {
      discardPendingChange();
    },
    [discardPendingChange, scopeKey],
  );

  // Called from Excalidraw's onChange. `isContentReadOnly` must match the value passed
  // to Excalidraw's `viewModeEnabled` this render. Read-only mode still permits
  // pan/zoom, so retain the fresh view while replacing its element argument with
  // the authoritative store scene.
  const handleExcalidrawChange = (
    elements: readonly WhiteboardElementJSON[],
    view: WhiteboardView,
    isContentReadOnly: boolean,
  ) => {
    if (pendingElementsRef.current === null) {
      pendingBaseElementsRef.current = store.getSnapshot().context.scene.elements;
    }
    pendingElementsRef.current = isContentReadOnly
      ? store.getSnapshot().context.scene.elements
      : elements;
    pendingViewRef.current = view;

    if (throttleTimeoutRef.current === null) {
      throttleTimeoutRef.current = window.setTimeout(flushPendingChange, CHANGE_THROTTLE_MS);
    }
  };

  const setOpen = (isOpen: boolean) => {
    const current = store.getSnapshot().context.scene;
    if (current.isOpen === isOpen) return;

    store.trigger.setScene({ scene: { ...current, isOpen } });
    onWhiteboardEventRef.current?.({ timestamp: performance.now(), isOpen });
  };

  const setMaximized = (isMaximized: boolean) => {
    const current = store.getSnapshot().context.scene;
    if (current.isMaximized === isMaximized) return;
    store.trigger.setScene({ scene: { ...current, isMaximized } });
    onWhiteboardEventRef.current?.({ timestamp: performance.now(), isMaximized });
  };

  const applyView = (view: WhiteboardView, isMaximized: boolean) => {
    const current = store.getSnapshot().context.scene;
    const viewChanged = !areWhiteboardViewsEqual(current.view, view);
    const maximizedChanged = current.isMaximized !== isMaximized;
    if (!viewChanged && !maximizedChanged) return;
    store.trigger.setScene({
      scene: {
        ...current,
        view: viewChanged ? structuredClone(view) : current.view,
        isMaximized,
      },
    });
    onWhiteboardEventRef.current?.({
      timestamp: performance.now(),
      ...(viewChanged ? { view: structuredClone(view) } : {}),
      ...(maximizedChanged ? { isMaximized } : {}),
    });
  };

  return {
    scene,
    isOpen: scene.isOpen,
    setOpen,
    setMaximized,
    applyView,
    handleExcalidrawChange,
  };
};

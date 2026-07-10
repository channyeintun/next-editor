import { useEffect, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import {
  areWhiteboardViewsEqual,
  deriveWhiteboardDelta,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardView,
} from "../core/src/whiteboard";
import { selectScene, type WhiteboardStoreInstance } from "../stores/whiteboardStore";

interface UseWhiteboardControllerConfig {
  store: WhiteboardStoreInstance;
  onWhiteboardEvent?: (event: WhiteboardEvent) => void;
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
 * `isReadOnly` fresh on every call, driven by the editor machine's own
 * `usesPlaybackModel` state. That state already flips back to `false` the instant
 * playback stops, recording starts, or the recording unloads — mirroring it in a
 * separate store field would need the same resets duplicated and re-verified here.
 */
export const useWhiteboardController = ({
  store,
  onWhiteboardEvent,
}: UseWhiteboardControllerConfig) => {
  const scene = useSelector(store, (snapshot) => selectScene(snapshot.context));

  const onWhiteboardEventRef = useRef(onWhiteboardEvent);
  useEffect(() => {
    onWhiteboardEventRef.current = onWhiteboardEvent;
  }, [onWhiteboardEvent]);

  const throttleTimeoutRef = useRef<number | null>(null);
  const pendingElementsRef = useRef<readonly WhiteboardElementJSON[] | null>(null);
  const pendingViewRef = useRef<WhiteboardView | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (throttleTimeoutRef.current !== null) {
        window.clearTimeout(throttleTimeoutRef.current);
      }
    };
  }, []);

  const flushPendingChange = () => {
    throttleTimeoutRef.current = null;
    const elements = pendingElementsRef.current;
    pendingElementsRef.current = null;
    if (!elements) return;

    const current = store.getSnapshot().context.scene;
    const { upserts, removedIds } = deriveWhiteboardDelta(current.elements, elements);
    const view = pendingViewRef.current;
    const viewChanged = Boolean(view) && !areWhiteboardViewsEqual(view, current.view);

    if (!upserts.length && !removedIds.length && !viewChanged) {
      return;
    }

    store.trigger.setScene({
      scene: {
        elements: elements as WhiteboardElementJSON[],
        view: viewChanged && view ? view : current.view,
        isOpen: current.isOpen,
        isMaximized: current.isMaximized,
      },
    });

    onWhiteboardEventRef.current?.({
      timestamp: performance.now(),
      ...(upserts.length ? { upserts } : {}),
      ...(removedIds.length ? { removedIds } : {}),
      ...(viewChanged ? { view } : {}),
    });
  };

  // Called from Excalidraw's onChange. `isReadOnly` must be the same value passed
  // to Excalidraw's `viewModeEnabled` this render — while true, Excalidraw itself
  // blocks user edits, so the only onChange fires are our own replay-driven
  // `updateScene` calls round-tripping back; drop them here instead of re-recording
  // the replayed state as if the presenter had drawn it live.
  const handleExcalidrawChange = (
    elements: readonly WhiteboardElementJSON[],
    view: WhiteboardView,
    isReadOnly: boolean,
  ) => {
    if (isReadOnly) return;

    pendingElementsRef.current = elements;
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

  return {
    scene,
    isOpen: scene.isOpen,
    setOpen,
    handleExcalidrawChange,
  };
};

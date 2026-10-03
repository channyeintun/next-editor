import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import {
  areWhiteboardViewsEqual,
  deriveWhiteboardDelta,
  rebaseWhiteboardDelta,
  snapshotWhiteboardDelta,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardView,
} from "../core/src/whiteboard";
import {
  selectScene,
  selectWhiteboardSceneUpdateSource,
  type WhiteboardStoreInstance,
} from "../stores/whiteboardStore";

interface UseWhiteboardControllerConfig {
  store: WhiteboardStoreInstance;
  onWhiteboardEvent?: (event: WhiteboardEvent) => boolean | void;
  scopeKey?: unknown;
  /**
   * Non-null during a playback session (playing, paused or ended), identifying the recording
   * (its id). See the release effect below.
   */
  playbackKey?: string | null;
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

function hasWhiteboardElementChanges(
  previousElements: readonly WhiteboardElementJSON[],
  elements: readonly WhiteboardElementJSON[],
): boolean {
  const { upserts, removedIds } = deriveWhiteboardDelta(previousElements, elements);
  return upserts.length > 0 || removedIds.length > 0;
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
  playbackKey = null,
}: UseWhiteboardControllerConfig) => {
  const scene = useSelector(store, (snapshot) => selectScene(snapshot.context));
  const sceneUpdateSource = useSelector(store, (snapshot) =>
    selectWhiteboardSceneUpdateSource(snapshot.context),
  );

  const onWhiteboardEventRef = useRef(onWhiteboardEvent);
  useEffect(() => {
    onWhiteboardEventRef.current = onWhiteboardEvent;
  }, [onWhiteboardEvent]);

  const throttleTimeoutRef = useRef<number | null>(null);
  const pendingElementsRef = useRef<readonly WhiteboardElementJSON[] | null>(null);
  const pendingBaseElementsRef = useRef<readonly WhiteboardElementJSON[] | null>(null);
  const pendingViewRef = useRef<WhiteboardView | undefined>(undefined);
  // What the open window's canvas looked like when it was last given a scene.
  // Null when the window has no such check. See markCanvasSynced.
  const pendingCanvasBaseRef = useRef<readonly WhiteboardElementJSON[] | null>(null);
  // The scene the mounted canvas was last given (null if unknown) and copies of
  // what Excalidraw made of it. Null when nothing was given since the last save.
  const syncedCanvasRef = useRef<{
    given: readonly WhiteboardElementJSON[] | null;
    canvas: readonly WhiteboardElementJSON[];
  } | null>(null);

  const discardPendingChange = useCallback(() => {
    if (throttleTimeoutRef.current !== null) {
      window.clearTimeout(throttleTimeoutRef.current);
    }
    throttleTimeoutRef.current = null;
    pendingElementsRef.current = null;
    pendingBaseElementsRef.current = null;
    pendingCanvasBaseRef.current = null;
    pendingViewRef.current = undefined;
    syncedCanvasRef.current = null;
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
    const canvasBase = pendingCanvasBaseRef.current;
    pendingCanvasBaseRef.current = null;
    const view = pendingViewRef.current;
    pendingViewRef.current = undefined;
    if (!elements) return;

    const current = store.getSnapshot().context.scene;
    // The canvas still shows exactly the scene it was given, as Excalidraw tidied
    // it: nobody edited anything, so there is nothing to record (see markCanvasSynced).
    const edited = !canvasBase || hasWhiteboardElementChanges(canvasBase, elements);
    // Snapshots, not live references: Excalidraw mutates elements in place while
    // drawing, so the store must hold clones for the diff (and the recorded
    // upserts) to see each flush's intermediate state — that per-flush growth of
    // a stroke's points is what makes it animate on replay.
    const snapshot = edited
      ? snapshotWhiteboardDelta(baseElements ?? current.elements, elements)
      : null;
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
    const nextView = viewChanged && view ? view : current.view;
    if (onWhiteboardEventRef.current?.(event) === false) {
      // The room refused the content change, so the canvas is showing elements the store and
      // the room do not have. Keep the store's elements and mark the scene external, which is
      // what makes WhiteboardPanel push it back into Excalidraw; the local pan/zoom stays.
      store.trigger.setScene({ scene: { ...current, view: nextView }, source: "external" });
      return;
    }

    let nextElements = current.elements;
    if (snapshot) {
      nextElements =
        baseElements === current.elements
          ? snapshot.nextElements
          : rebaseWhiteboardDelta(current.elements, snapshot);
      // The store now holds what the canvas shows, so it is the baseline again.
      syncedCanvasRef.current = null;
    }
    store.trigger.setScene({
      scene: {
        elements: nextElements,
        view: nextView,
        isOpen: current.isOpen,
        isMaximized: current.isMaximized,
      },
      // This scene came from the mounted Excalidraw instance. Consumers must
      // not feed the throttled snapshot back into that same canvas while the
      // pointer gesture is still growing.
      source: "canvas",
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

  // The viewer's playback pan/zoom (playbackViewerView, set by WhiteboardPanel) lasts for one
  // playback session of one recording: through play, pause, seeks, the end screen (and
  // replaying from it), the viewer editing the workspace (which only pauses the lesson) and
  // the whiteboard closing and reopening. It ends when the session does: STOP rewinds to the
  // ready state, the recording unloads, or a different recording loads. The canvas then
  // shows the scene's own view again. A followed participant's view also replaces it (see
  // applyView).
  useLayoutEffect(
    () => () => {
      store.trigger.releasePlaybackViewerView();
    },
    [playbackKey, store],
  );

  // Called from Excalidraw's onChange. `isContentReadOnly` must match the value passed
  // to Excalidraw's `viewModeEnabled` this render. Read-only mode still permits
  // pan/zoom, so retain the fresh view while replacing its element argument with the
  // window's base scene, so only the view can change. A playing lesson never calls
  // this: the panel keeps the viewer's view out of the scene (see
  // observePlaybackCanvasView).
  const handleExcalidrawChange = (
    elements: readonly WhiteboardElementJSON[],
    view: WhiteboardView,
    isContentReadOnly: boolean,
  ) => {
    if (pendingElementsRef.current === null) {
      const synced = syncedCanvasRef.current;
      pendingBaseElementsRef.current = synced?.given ?? store.getSnapshot().context.scene.elements;
      pendingCanvasBaseRef.current = synced?.canvas ?? null;
    }
    pendingElementsRef.current = isContentReadOnly ? pendingBaseElementsRef.current : elements;
    pendingViewRef.current = view;

    if (throttleTimeoutRef.current === null) {
      throttleTimeoutRef.current = window.setTimeout(flushPendingChange, CHANGE_THROTTLE_MS);
    }
  };

  /**
   * The panel calls this each time it gives the canvas a scene: right after it
   * pushes the store's scene in with updateScene (`givenElements` is that
   * scene), and with the scene a newly mounted canvas loaded. Excalidraw tidies
   * any scene it is given: an element with no z-order `index` (every authored
   * studio asset) gets one, which also bumps its version and nonce. Then
   * Excalidraw reports the tidied scene back through onChange.
   *
   * That report used to be recorded as an edit. In a studio render the store
   * moves every 50 ms and the report was often one step old, so the recording
   * got a stale, indexed copy of the piece being drawn after each newer step.
   * On playback each piece jumped back a step and drew again, and the copy's
   * `index` lifted it above the filled box around it until the next step put it
   * below again, so labels flashed as they were typed.
   *
   * Now a window in which the canvas still matches what Excalidraw made of the
   * given scene records nothing. A real edit is still diffed against the given
   * scene, as before, so it also takes in Excalidraw's indexes.
   */
  const markCanvasSynced = (
    canvasElements: readonly WhiteboardElementJSON[],
    givenElements: readonly WhiteboardElementJSON[] | null = null,
  ) => {
    // Copies, because Excalidraw changes its element objects in place while drawing.
    const canvas = canvasElements.map((element) => structuredClone(element));
    syncedCanvasRef.current = { given: givenElements, canvas };
    // The new scene replaced whatever the canvas showed before, so a change
    // that is still waiting to be saved starts from here as well.
    if (pendingElementsRef.current !== null) {
      pendingBaseElementsRef.current = givenElements ?? store.getSnapshot().context.scene.elements;
      pendingCanvasBaseRef.current = canvas;
      pendingElementsRef.current = canvasElements;
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
    // Following someone (possible while a lesson is paused) shows their view, not the pan
    // the viewer kept from playback; their own next pan stops following and takes it back.
    if (viewChanged) store.trigger.releasePlaybackViewerView();
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
    sceneUpdateSource,
    isOpen: scene.isOpen,
    setOpen,
    setMaximized,
    applyView,
    handleExcalidrawChange,
    markCanvasSynced,
  };
};

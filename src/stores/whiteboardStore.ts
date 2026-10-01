import { createStore } from "@xstate/store-react";
import {
  areWhiteboardViewsEqual,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardSceneState,
  type WhiteboardView,
} from "../core/src/whiteboard";

export interface WhiteboardStoreContext {
  scene: WhiteboardSceneState;
  sceneUpdateSource: WhiteboardSceneUpdateSource;
  /**
   * The pan/zoom a viewer gave the canvas while a recording plays, or null while the canvas
   * follows the recorded view. It is viewer-only state: it never enters `scene` (whose
   * elements are shared with the recording and the replay fold cache) or a whiteboard event.
   * useWhiteboardController releases it when playback hands the canvas back to live editing
   * or a different recording loads.
   */
  playbackViewerView: WhiteboardView | null;
}

export type WhiteboardSceneUpdateSource = "canvas" | "external";

export function createWhiteboardStore() {
  return createStore({
    context: {
      scene: EMPTY_WHITEBOARD_SCENE,
      sceneUpdateSource: "external",
      playbackViewerView: null,
    } as WhiteboardStoreContext,
    on: {
      setScene: (
        context,
        event: { scene: WhiteboardSceneState; source?: WhiteboardSceneUpdateSource },
      ): WhiteboardStoreContext =>
        event.scene === context.scene
          ? context
          : {
              ...context,
              scene: event.scene,
              sceneUpdateSource: event.source ?? "external",
            },
      // Fed by every Excalidraw onChange during playback. Excalidraw also fires onChange after
      // WhiteboardPanel's own updateScene (and after its initial load), reporting exactly the
      // view the panel applied, so only a view that differs from `appliedView` is the viewer's.
      observePlaybackCanvasView: (
        context,
        event: { view: WhiteboardView; appliedView: WhiteboardView | null },
      ): WhiteboardStoreContext =>
        event.appliedView === null ||
        areWhiteboardViewsEqual(event.view, event.appliedView) ||
        areWhiteboardViewsEqual(event.view, context.playbackViewerView ?? undefined)
          ? context
          : { ...context, playbackViewerView: { ...event.view } },
      releasePlaybackViewerView: (context): WhiteboardStoreContext =>
        context.playbackViewerView === null ? context : { ...context, playbackViewerView: null },
    },
  });
}

export type WhiteboardStoreInstance = ReturnType<typeof createWhiteboardStore>;

export function snapshotWhiteboardStore(store: WhiteboardStoreInstance): WhiteboardSceneState {
  return structuredClone(store.getSnapshot().context.scene);
}

export function restoreWhiteboardStore(
  store: WhiteboardStoreInstance,
  scene: WhiteboardSceneState,
): void {
  store.trigger.setScene({ scene: structuredClone(scene) });
}

export const selectScene = (context: WhiteboardStoreContext): WhiteboardSceneState => context.scene;

export const selectWhiteboardSceneUpdateSource = (
  context: WhiteboardStoreContext,
): WhiteboardSceneUpdateSource => context.sceneUpdateSource;

export const selectHasPlaybackViewerView = (context: WhiteboardStoreContext): boolean =>
  context.playbackViewerView !== null;

/**
 * The view WhiteboardPanel shows with a scene. While the playback model drives the canvas
 * and the viewer has panned or zoomed, that is the viewer's view and `applyView` is false:
 * the scene update carries only the elements, so recorded drawing keeps appearing without
 * moving the canvas or rewinding a pan in progress. Otherwise it is the scene's own view,
 * applied as before (live editing never reads `playbackViewerView`).
 */
export function planWhiteboardCanvasView(
  sceneView: WhiteboardView,
  playbackViewerView: WhiteboardView | null,
  usesPlaybackModel: boolean,
): { view: WhiteboardView; applyView: boolean } {
  if (usesPlaybackModel && playbackViewerView) {
    return { view: playbackViewerView, applyView: false };
  }
  return { view: sceneView, applyView: true };
}

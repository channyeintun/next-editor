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
   * The pan/zoom a viewer gave the canvas during a playback session (playing, paused or
   * ended), or null while the canvas follows the recorded view. It is viewer-only state: it
   * never enters a recording, and while the lesson plays it never enters `scene` (whose
   * elements are shared with the recording and the replay fold cache) either.
   * useWhiteboardController releases it when the session ends (see its release effect).
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
      // Fed by every Excalidraw onChange during a playback session. Excalidraw also fires
      // onChange after WhiteboardPanel's own updateScene (and after its initial load),
      // reporting exactly the view the panel applied, so only a view that differs from
      // `appliedView` takes the viewport over. Once the viewer owns it, every view change is
      // theirs: a recorded scene no longer moves the canvas.
      observePlaybackCanvasView: (
        context,
        event: { view: WhiteboardView; appliedView: WhiteboardView | null },
      ): WhiteboardStoreContext => {
        const isViewerView = context.playbackViewerView
          ? !areWhiteboardViewsEqual(event.view, context.playbackViewerView)
          : event.appliedView !== null && !areWhiteboardViewsEqual(event.view, event.appliedView);
        return isViewerView ? { ...context, playbackViewerView: { ...event.view } } : context;
      },
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

/**
 * The view WhiteboardPanel shows with a scene. During a playback session (playing, paused
 * or ended) in which the viewer has panned or zoomed, that is the viewer's view and
 * `applyView` is false: the scene update carries only the elements, so recorded drawing
 * keeps appearing without moving the canvas or rewinding a pan in progress. Otherwise it is
 * the scene's own view, applied as before (live editing never reads `playbackViewerView`).
 */
export function planWhiteboardCanvasView(
  sceneView: WhiteboardView,
  playbackViewerView: WhiteboardView | null,
  isInPlaybackSession: boolean,
): { view: WhiteboardView; applyView: boolean } {
  if (isInPlaybackSession && playbackViewerView) {
    return { view: playbackViewerView, applyView: false };
  }
  return { view: sceneView, applyView: true };
}

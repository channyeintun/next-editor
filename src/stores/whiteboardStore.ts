import { createStore } from "@xstate/store-react";
import { EMPTY_WHITEBOARD_SCENE, type WhiteboardSceneState } from "../core/src/whiteboard";

export interface WhiteboardStoreContext {
  scene: WhiteboardSceneState;
  sceneUpdateSource: WhiteboardSceneUpdateSource;
}

export type WhiteboardSceneUpdateSource = "canvas" | "external";

export function createWhiteboardStore() {
  return createStore({
    context: {
      scene: EMPTY_WHITEBOARD_SCENE,
      sceneUpdateSource: "external",
    } as WhiteboardStoreContext,
    on: {
      setScene: (
        context,
        event: { scene: WhiteboardSceneState; source?: WhiteboardSceneUpdateSource },
      ): WhiteboardStoreContext =>
        event.scene === context.scene
          ? context
          : {
              scene: event.scene,
              sceneUpdateSource: event.source ?? "external",
            },
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

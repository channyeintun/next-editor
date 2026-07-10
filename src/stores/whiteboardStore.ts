import { createStore } from "@xstate/store-react";
import { EMPTY_WHITEBOARD_SCENE, type WhiteboardSceneState } from "../core/src/whiteboard";

export interface WhiteboardStoreContext {
  scene: WhiteboardSceneState;
}

export function createWhiteboardStore() {
  return createStore({
    context: { scene: EMPTY_WHITEBOARD_SCENE } as WhiteboardStoreContext,
    on: {
      setScene: (context, event: { scene: WhiteboardSceneState }): WhiteboardStoreContext =>
        event.scene === context.scene ? context : { scene: event.scene },
    },
  });
}

export type WhiteboardStoreInstance = ReturnType<typeof createWhiteboardStore>;

export const selectScene = (context: WhiteboardStoreContext): WhiteboardSceneState => context.scene;

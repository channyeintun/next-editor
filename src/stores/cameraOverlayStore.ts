import { createStore } from "@xstate/store-react";
import type { AnyActorRef } from "xstate";
import { readStoredPreference, writeStoredPreference } from "./preferenceStorage";

const VISIBLE_KEY = "next-editor-camera-overlay-visible";
const MINIMIZED_KEY = "next-editor-camera-overlay-minimized";

export interface CameraOverlayContext {
  /** Whether a recording's camera is shown; the viewer hides it from the player bar. */
  visible: boolean;
  /** Whether the overlay is collapsed to a handle at the screen edge. */
  minimized: boolean;
  /**
   * The editor whose camera is switched on for the next take (its actor, which its player bar
   * and its overlay share), or null; that overlay shows the camera live meanwhile. Never
   * stored. Kept per editor rather than as a flag so the switch ends with its player bar: an
   * editor mounted later, even in the render that replaces this one, starts with the camera
   * off, as it did when the switch was the player bar's own state.
   */
  livePreviewEditor: AnyActorRef | null;
}

function readInitialContext(): CameraOverlayContext {
  return {
    visible: readStoredPreference(VISIBLE_KEY) !== "false",
    minimized: readStoredPreference(MINIMIZED_KEY) === "true",
    livePreviewEditor: null,
  };
}

export function createCameraOverlayStore() {
  const store = createStore({
    context: readInitialContext(),
    on: {
      toggleVisible: (context) => ({ ...context, visible: !context.visible }),
      setMinimized: (context, event: { minimized: boolean }) =>
        event.minimized === context.minimized
          ? context
          : { ...context, minimized: event.minimized },
      toggleLivePreview: (context, event: { editor: AnyActorRef }) => ({
        ...context,
        livePreviewEditor: context.livePreviewEditor === event.editor ? null : event.editor,
      }),
      /** Switches the editor's camera off, if it is on; its player bar is going away. */
      stopLivePreview: (context, event: { editor: AnyActorRef }) =>
        context.livePreviewEditor === event.editor
          ? { ...context, livePreviewEditor: null }
          : context,
    },
  });

  // Each preference is written when it changes, as the player bar and the overlay did
  // when they kept it themselves.
  let written = store.getSnapshot().context;
  store.subscribe(({ context }) => {
    if (context.visible !== written.visible) {
      writeStoredPreference(VISIBLE_KEY, String(context.visible));
    }
    if (context.minimized !== written.minimized) {
      writeStoredPreference(MINIMIZED_KEY, String(context.minimized));
    }
    written = context;
  });

  return store;
}

// Module-level singleton — the overlay and the player bar's camera buttons are sibling
// components of the Editor, and the viewer's choices are the same in every editor, so one
// shared instance serves both without a provider, like playbackSettingsStore. Only the
// live preview is per editor (see livePreviewEditor).
export const cameraOverlayStore = createCameraOverlayStore();

export const selectCameraOverlayVisible = (context: CameraOverlayContext): boolean =>
  context.visible;
export const selectCameraOverlayMinimized = (context: CameraOverlayContext): boolean =>
  context.minimized;
export const selectLivePreviewOn = (context: CameraOverlayContext, editor: AnyActorRef): boolean =>
  context.livePreviewEditor === editor;

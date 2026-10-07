import {
  DEFAULT_PREVIEW_STATE,
  restoreSlidesStore,
  setSlidesStoreDeckBorrowed,
  snapshotSlidesStore,
  type SlidesStoreInstance,
  type SlidesStoreSnapshot,
} from "../stores/slidesStore";
import {
  restoreWhiteboardStore,
  snapshotWhiteboardStore,
  type WhiteboardStoreInstance,
} from "../stores/whiteboardStore";
import type { Slide, SlideEvent } from "../types/slides";
import {
  EMPTY_WHITEBOARD_SCENE,
  snapshotWhiteboardDelta,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../core/src/whiteboard";
import type { CollaborationTeachingProjection } from "./teachingDocument";

/** The deck and whiteboard this tab showed before it entered a room. */
export interface StandaloneTeachingStores {
  slides: SlidesStoreSnapshot;
  whiteboard: WhiteboardSceneState;
}

/**
 * Lends the local slides and whiteboard stores to a room: snapshots them, marks
 * the deck borrowed so the room's deck is never persisted as the user's own,
 * and empties both for the room's projection. `restore` puts the snapshot back.
 */
export function borrowStandaloneTeachingStores(
  slidesStore: SlidesStoreInstance,
  whiteboardStore: WhiteboardStoreInstance,
): { snapshot: StandaloneTeachingStores; restore: () => void } {
  const snapshot: StandaloneTeachingStores = {
    slides: snapshotSlidesStore(slidesStore),
    whiteboard: snapshotWhiteboardStore(whiteboardStore),
  };
  setSlidesStoreDeckBorrowed(slidesStore, true);
  slidesStore.trigger.setSlides({ slides: [] });
  // A copy: the store ignores the preview state it already holds, and a store
  // that was never opened still holds DEFAULT_PREVIEW_STATE itself.
  slidesStore.trigger.setPreviewState({ previewState: { ...DEFAULT_PREVIEW_STATE } });
  whiteboardStore.trigger.setScene({ scene: structuredClone(EMPTY_WHITEBOARD_SCENE) });
  return {
    snapshot,
    restore: () => {
      restoreSlidesStore(slidesStore, snapshot.slides);
      restoreWhiteboardStore(whiteboardStore, snapshot.whiteboard);
    },
  };
}

/**
 * Shows the room's hydrated presentation in the local slides store: its deck,
 * unless the store's matches slide for slide, and its current slide. The
 * viewer's build step (`indexv`) is kept only while neither the presentation
 * nor its current slide has changed.
 */
export function applyTeachingSlides(
  store: SlidesStoreInstance,
  teachingSlides: Slide[],
  currentSlideId: string | null,
  presentationRevisionChanged: boolean,
): void {
  const current = store.getSnapshot().context;
  const sameSlides =
    current.slides.length === teachingSlides.length &&
    current.slides.every(
      (slide, index) =>
        slide.id === teachingSlides[index]?.id && slide.content === teachingSlides[index]?.content,
    );
  if (!sameSlides) store.trigger.setSlides({ slides: teachingSlides });
  const nextPreview = {
    ...current.previewState,
    currentSlideId,
    indexv:
      !presentationRevisionChanged && current.previewState.currentSlideId === currentSlideId
        ? (current.previewState.indexv ?? 0)
        : 0,
  };
  if (
    current.previewState.currentSlideId !== nextPreview.currentSlideId ||
    current.previewState.indexv !== nextPreview.indexv
  ) {
    store.trigger.setPreviewState({ previewState: nextPreview });
  }
}

/**
 * Shows the room's whiteboard elements in the local whiteboard store. Returns
 * whether they are the canvas's own echo, the projection of the delta this tab
 * last published (`localProjectionFingerprint`): the store then receives them
 * as a canvas update, and the caller stops expecting the echo.
 */
export function applyTeachingWhiteboard(
  store: WhiteboardStoreInstance,
  whiteboardElements: readonly WhiteboardElementJSON[],
  localProjectionFingerprint: string | null,
): boolean {
  const currentScene = store.getSnapshot().context.scene;
  const isLocalCanvasProjection = localProjectionFingerprint === JSON.stringify(whiteboardElements);
  const sameElements =
    currentScene.elements.length === whiteboardElements.length &&
    currentScene.elements.every((element, index) => {
      const projected = whiteboardElements[index];
      return (
        element.id === projected?.id &&
        element.version === projected.version &&
        element.versionNonce === projected.versionNonce &&
        element.isDeleted === projected.isDeleted &&
        JSON.stringify(element) === JSON.stringify(projected)
      );
    });
  if (!sameElements) {
    store.trigger.setScene({
      scene: {
        ...currentScene,
        elements: whiteboardElements.map((element) => structuredClone(element)),
      },
      source: isLocalCanvasProjection ? "canvas" : "external",
    });
  }
  return isLocalCanvasProjection;
}

/**
 * Records a live change to the room's teaching surfaces, from `previous` to
 * `projection`, in the host's recording: a new current slide and the
 * whiteboard delta. In a room the slide and whiteboard panels publish these
 * changes to the room instead of recording them, so the recording takes them
 * from the room's projection, which is canonical.
 */
export function recordCanonicalTeachingChange(
  previous: CollaborationTeachingProjection | null,
  projection: CollaborationTeachingProjection,
  isRecordingHost: boolean,
  recorder: {
    handleSlideEvent: (event: SlideEvent) => void;
    handleWhiteboardEvent: (event: WhiteboardEvent) => void;
  },
): void {
  // A known uninitialized projection becoming initialized is a live room
  // change (and must be recorded); `previous === null` is first hydration.
  if (!previous || !projection.initialized || !isRecordingHost) return;
  if (previous.currentSlideId !== projection.currentSlideId && projection.currentSlideId) {
    recorder.handleSlideEvent({
      type: "slide_change",
      timestamp: performance.now(),
      slideId: projection.currentSlideId,
      indexv: 0,
    });
  }
  const delta = snapshotWhiteboardDelta(previous.whiteboardElements, projection.whiteboardElements);
  if (delta) {
    recorder.handleWhiteboardEvent({
      timestamp: performance.now(),
      ...(delta.upserts.length ? { upserts: delta.upserts } : {}),
      ...(delta.removedIds.length ? { removedIds: delta.removedIds } : {}),
    });
  }
}

/**
 * Identifies what hydrating the room's presentation downloads: the room and
 * each slide's payload. Changes to the rest of the projection (the current
 * slide, the whiteboard) keep the key, so they do not reload the deck.
 */
export function teachingHydrationKey(
  roomId: string,
  projection: CollaborationTeachingProjection,
): string {
  return JSON.stringify({
    roomId,
    initialized: projection.initialized,
    slides: projection.slideOrder.map((slideId) => {
      const manifest = projection.slides.get(slideId);
      return manifest
        ? [slideId, manifest.contentType, manifest.asset.id, manifest.asset.size]
        : [slideId, null];
    }),
  });
}

/**
 * Whether two projections of the room's teaching surfaces show the same
 * state. Whiteboard elements compare by identity: the projection reuses the
 * element of every record whose candidates did not change, so equal
 * references mean an unchanged element, and a different one only costs an
 * update that changes nothing.
 */
export function isSameTeachingProjection(
  left: CollaborationTeachingProjection,
  right: CollaborationTeachingProjection,
): boolean {
  if (
    left.initialized !== right.initialized ||
    left.currentSlideId !== right.currentSlideId ||
    left.presentationRevision !== right.presentationRevision ||
    left.slideOrder.length !== right.slideOrder.length ||
    left.slides.size !== right.slides.size ||
    left.whiteboardElements.length !== right.whiteboardElements.length
  ) {
    return false;
  }
  return (
    left.slideOrder.every((slideId, index) => slideId === right.slideOrder[index]) &&
    Array.from(left.slides).every(
      ([slideId, manifest]) =>
        JSON.stringify(manifest) === JSON.stringify(right.slides.get(slideId)),
    ) &&
    left.whiteboardElements.every((element, index) => element === right.whiteboardElements[index])
  );
}

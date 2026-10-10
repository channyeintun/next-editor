import { useCallback, useRef, useState, type RefObject } from "react";
import type * as Y from "yjs";
import { downloadCollaborationAsset } from "@next-editor/infra";
import { messageFromError } from "../../collaboration/errorMessage";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";
import { publishCollaborationTeachingInitialization } from "../../collaboration/roomSetup";
import {
  projectCollaborationTeachingDocument,
  setCollaborationCurrentSlide,
  UNINITIALIZED_TEACHING_PROJECTION,
  type CollaborationTeachingProjection,
} from "../../collaboration/teachingDocument";
import { isCollaborationTeachingInitialized } from "../../collaboration/teachingRoot";
import { hydrateCollaborationSlideManifest } from "../../collaboration/teachingSlides";
import {
  applyTeachingSlides,
  applyTeachingWhiteboard,
  isSameTeachingProjection,
  recordCanonicalTeachingChange,
  teachingHydrationKey,
  type StandaloneTeachingStores,
} from "../../collaboration/teachingStoreSync";
import { applyCollaborationWhiteboardDelta } from "../../collaboration/teachingWhiteboard";
import type { WhiteboardEvent } from "../../core/src/whiteboard";
import type { SlidesStoreInstance } from "../../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../../stores/whiteboardStore";
import type { Slide, SlideEvent } from "../../types/slides";

interface CollaborationTeachingOptions {
  providerRef: RefObject<CollaborationRoomProvider | null>;
  /** The signed-in user; only the room's host records teaching changes. */
  userRef: RefObject<{ id: string } | null>;
  isRecordingRef: RefObject<boolean>;
  playbackRef: RefObject<boolean>;
  /** The deck and whiteboard this tab lent to the room it is in. */
  standaloneStoresRef: RefObject<({ roomId: string } & StandaloneTeachingStores) | null>;
  handleSlideEvent: (event: SlideEvent) => void;
  handleWhiteboardEvent: (event: WhiteboardEvent) => void;
  /** Shows a collaboration error, or clears it with null. */
  setError: (message: string | null) => void;
  /** Marks a shown error as one that retrying the room's assets can clear. */
  setRetryableAssetError: (message: string | null) => void;
}

/**
 * The room's shared slides and whiteboard: their projection, the slide
 * payloads it downloads, and the changes this member publishes to them. It
 * holds no effects; the provider runs the projection from the room's
 * document and applies the result to the stores.
 */
export function useCollaborationTeaching({
  providerRef,
  userRef,
  isRecordingRef,
  playbackRef,
  standaloneStoresRef,
  handleSlideEvent,
  handleWhiteboardEvent,
  setError,
  setRetryableAssetError,
}: CollaborationTeachingOptions) {
  const [teaching, setTeaching] = useState<CollaborationTeachingProjection>(
    UNINITIALIZED_TEACHING_PROJECTION,
  );
  const [teachingSlides, setTeachingSlides] = useState<Slide[] | null>(null);
  const [isTeachingLoading, setIsTeachingLoading] = useState(false);
  const teachingProjectionRef = useRef<CollaborationTeachingProjection | null>(null);
  const localWhiteboardProjectionFingerprintRef = useRef<string | null>(null);
  const appliedPresentationRevisionRef = useRef<number | null>(null);
  const teachingHydrationGenerationRef = useRef(0);
  const teachingHydrationKeyRef = useRef<string | null>(null);
  const teachingSlideCacheRef = useRef(new Map<string, Promise<Uint8Array>>());

  const projectTeachingState = useCallback(
    (doc: Y.Doc, targetRoomId: string) => {
      let projection: CollaborationTeachingProjection;
      try {
        projection = projectCollaborationTeachingDocument(doc);
      } catch (error) {
        setError(messageFromError(error, "The shared teaching surfaces could not be projected."));
        return;
      }

      const previous = teachingProjectionRef.current;
      teachingProjectionRef.current = projection;
      // A teaching transaction that changes nothing shown (a peer's candidate
      // that loses, a re-projection) must not replace the context value and
      // re-render every collaboration consumer.
      if (!previous || !isSameTeachingProjection(previous, projection)) setTeaching(projection);

      const currentProvider = providerRef.current;
      const currentUser = userRef.current;
      recordCanonicalTeachingChange(
        previous,
        projection,
        Boolean(
          isRecordingRef.current &&
          currentProvider?.session &&
          currentUser &&
          currentProvider.session.room.hostUserId === currentUser.id,
        ),
        { handleSlideEvent, handleWhiteboardEvent },
      );

      const hydrationKey = teachingHydrationKey(targetRoomId, projection);
      if (teachingHydrationKeyRef.current === hydrationKey) return;
      teachingHydrationKeyRef.current = hydrationKey;

      const generation = ++teachingHydrationGenerationRef.current;
      if (!projection.initialized || projection.slideOrder.length === 0) {
        setTeachingSlides([]);
        setIsTeachingLoading(false);
        return;
      }
      setTeachingSlides(null);
      setIsTeachingLoading(true);
      const loads = projection.slideOrder.map((slideId) => {
        const manifest = projection.slides.get(slideId);
        if (!manifest) return Promise.reject(new Error("A shared slide manifest is missing."));
        return hydrateCollaborationSlideManifest(manifest, teachingSlideCacheRef.current, () =>
          downloadCollaborationAsset(targetRoomId, manifest.asset.id),
        );
      });
      void Promise.all(loads)
        .then((slides) => {
          if (
            generation !== teachingHydrationGenerationRef.current ||
            providerRef.current?.session?.room.id !== targetRoomId
          ) {
            return;
          }
          setTeachingSlides(slides.map((slide, index) => ({ ...slide, order: index })));
          setIsTeachingLoading(false);
        })
        .catch((error: unknown) => {
          if (generation !== teachingHydrationGenerationRef.current) return;
          setTeachingSlides(null);
          setIsTeachingLoading(false);
          const message = messageFromError(
            error,
            "The shared presentation could not be downloaded.",
          );
          setRetryableAssetError(message);
          setError(message);
        });
    },
    [
      handleSlideEvent,
      handleWhiteboardEvent,
      isRecordingRef,
      providerRef,
      setError,
      setRetryableAssetError,
      userRef,
    ],
  );

  /** Clears one room's teaching state; part of resetting the state of one room. */
  const resetTeaching = useCallback(() => {
    teachingProjectionRef.current = null;
    localWhiteboardProjectionFingerprintRef.current = null;
    appliedPresentationRevisionRef.current = null;
    teachingHydrationGenerationRef.current += 1;
    teachingHydrationKeyRef.current = null;
    teachingSlideCacheRef.current.clear();
    setTeaching(UNINITIALIZED_TEACHING_PROJECTION);
    setTeachingSlides(null);
    setIsTeachingLoading(false);
  }, []);

  /** Shows the teaching surfaces as loading until a joined room's first projection. */
  const beginTeachingLoad = useCallback(() => {
    setIsTeachingLoading(true);
  }, []);

  /** Makes a slide download still in flight for a stopped room ignore its result. */
  const invalidateTeachingHydration = useCallback(() => {
    teachingHydrationGenerationRef.current += 1;
  }, []);

  /** Downloads the room's slides again, past the cache that holds a failed download. */
  const retryTeachingHydration = useCallback(
    (doc: Y.Doc, targetRoomId: string) => {
      teachingSlideCacheRef.current.clear();
      teachingHydrationKeyRef.current = null;
      projectTeachingState(doc, targetRoomId);
    },
    [projectTeachingState],
  );

  /** Shows the room's current projection in the local slides and whiteboard stores. */
  const applyTeachingToStores = useCallback(
    (slidesStore: SlidesStoreInstance, whiteboardStore: WhiteboardStoreInstance) => {
      if (!teaching.initialized) return;
      if (teachingSlides) {
        const presentationRevisionChanged =
          appliedPresentationRevisionRef.current !== teaching.presentationRevision;
        appliedPresentationRevisionRef.current = teaching.presentationRevision;
        applyTeachingSlides(
          slidesStore,
          teachingSlides,
          teaching.currentSlideId,
          presentationRevisionChanged,
        );
      }
      const isLocalCanvasProjection = applyTeachingWhiteboard(
        whiteboardStore,
        teaching.whiteboardElements,
        localWhiteboardProjectionFingerprintRef.current,
      );
      if (isLocalCanvasProjection) localWhiteboardProjectionFingerprintRef.current = null;
    },
    [teaching, teachingSlides],
  );

  const initializeTeachingSurfaces = useCallback(async () => {
    const current = providerRef.current;
    const currentSession = current?.session;
    const standalone = standaloneStoresRef.current;
    if (!current || !currentSession || currentSession.membership.role !== "owner") {
      throw new Error("Only the room owner can initialize teaching surfaces.");
    }
    if (!standalone || standalone.roomId !== currentSession.room.id) {
      throw new Error("The standalone teaching surfaces are unavailable.");
    }
    if (isCollaborationTeachingInitialized(current.doc)) {
      throw new Error("The room teaching surfaces are already initialized.");
    }
    await publishCollaborationTeachingInitialization(
      currentSession.room.id,
      current.doc,
      standalone.slides.slides,
      standalone.whiteboard,
      current.clientId,
    );
  }, [providerRef, standaloneStoresRef]);

  /** Moves the room to `slideId`; `canWrite` is whether this member may change the room now. */
  const publishCurrentSlide = useCallback(
    (slideId: string, canWrite: boolean) => {
      const current = providerRef.current;
      if (!current || !canWrite || playbackRef.current) return false;
      try {
        // Throws unless the slide is in the room presentation, so returning means
        // the shared current slide is now `slideId`.
        setCollaborationCurrentSlide(current.doc, slideId);
        setError(null);
        return true;
      } catch (error) {
        setError(messageFromError(error, "The shared slide could not be changed."));
        return false;
      }
    },
    [playbackRef, providerRef, setError],
  );

  /** Shares a whiteboard delta; `canWrite` is whether this member may change the room now. */
  const publishWhiteboardDelta = useCallback(
    (event: Pick<WhiteboardEvent, "upserts" | "removedIds">, canWrite: boolean) => {
      const current = providerRef.current;
      if (!current || !canWrite || playbackRef.current) return false;
      if (!(event.upserts?.length || event.removedIds?.length)) return true;
      try {
        const { elements: next, accepted } = applyCollaborationWhiteboardDelta(current.doc, event);
        // The teaching projection of these transactions runs in a microtask and
        // React applies it to the stores in an effect, both after this callback.
        // Tag that exact authoritative result so normalization cannot make this
        // local canvas echo look like a remote scene update. Only an accepted
        // delta is an echo: when another client's version won, the canvas does
        // not show the result and the projection must reach it.
        if (accepted) {
          localWhiteboardProjectionFingerprintRef.current = JSON.stringify(next);
        }
        setError(null);
        return accepted;
      } catch (error) {
        setError(messageFromError(error, "The whiteboard change could not be shared."));
        return false;
      }
    },
    [playbackRef, providerRef, setError],
  );

  return {
    teaching,
    teachingSlides,
    isTeachingLoading,
    projectTeachingState,
    resetTeaching,
    beginTeachingLoad,
    invalidateTeachingHydration,
    retryTeachingHydration,
    applyTeachingToStores,
    initializeTeachingSurfaces,
    publishCurrentSlide,
    publishWhiteboardDelta,
  };
}

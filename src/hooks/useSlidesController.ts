import { useRef, useEffect } from "react";
import { useSelector } from "@xstate/store-react";
import type { Slide, SlideEvent, SlidePreviewState } from "../types/slides";
import { selectPreviewState, selectSlides, type SlidesStoreInstance } from "../stores/slidesStore";

interface UseSlidesControllerConfig {
  store: SlidesStoreInstance;
  onSlideEvent?: (event: SlideEvent) => boolean | void;
  retainSlideOnClose?: boolean;
  resetBuildStepOnOpen?: boolean;
}

/**
 * The preview state after a slide event: `prev` itself when the event changes
 * nothing, which the store keeps without emitting. A close keeps the current
 * slide when `retainSlideOnClose` (SlidesProvider sets it in a live room).
 */
export function nextSlidePreviewState(
  prev: SlidePreviewState,
  event: SlideEvent,
  { retainSlideOnClose }: { retainSlideOnClose: boolean },
): SlidePreviewState {
  switch (event.type) {
    case "slide_open": {
      const nextSlideId = event.slideId || prev.currentSlideId;
      const nextIndexv = event.indexv ?? 0;
      const nextIsMaximized = event.isMaximized ?? true;

      if (
        prev.isOpen &&
        prev.currentSlideId === nextSlideId &&
        prev.indexv === nextIndexv &&
        prev.isMaximized === nextIsMaximized
      ) {
        return prev;
      }

      return {
        ...prev,
        isOpen: true,
        isMaximized: nextIsMaximized,
        currentSlideId: nextSlideId,
        indexv: nextIndexv,
      };
    }
    case "slide_close":
      if (
        !prev.isOpen &&
        !prev.isMaximized &&
        (retainSlideOnClose || prev.currentSlideId === null)
      ) {
        return prev;
      }
      return {
        ...prev,
        isOpen: false,
        isMaximized: false,
        currentSlideId: retainSlideOnClose ? prev.currentSlideId : null,
        indexv: 0,
      };
    case "slide_maximize":
      if (prev.isMaximized === (event.isMaximized || false)) {
        return prev;
      }
      return { ...prev, isMaximized: event.isMaximized || false };
    case "slide_minimize":
      if (!prev.isMaximized) {
        return prev;
      }
      return { ...prev, isMaximized: false };
    case "slide_change": {
      const targetIndexv = event.indexv ?? 0;
      if (
        prev.currentSlideId === (event.slideId || prev.currentSlideId) &&
        prev.indexv === targetIndexv
      ) {
        return prev;
      }
      return {
        ...prev,
        currentSlideId: event.slideId || prev.currentSlideId,
        indexv: targetIndexv,
      };
    }
    case "slide_interaction":
      if (prev.currentInteraction === event.interaction) {
        return prev;
      }
      return {
        ...prev,
        currentInteraction: event.interaction,
      };
    default:
      // An event type outside SlideEvent's union changes nothing.
      return prev;
  }
}

export const useSlidesController = ({
  store,
  onSlideEvent,
  retainSlideOnClose = false,
  resetBuildStepOnOpen = false,
}: UseSlidesControllerConfig) => {
  const slides = useSelector(store, (snapshot) => selectSlides(snapshot.context));
  const previewState = useSelector(store, (snapshot) => selectPreviewState(snapshot.context));

  const setSlides = (nextSlides: Slide[]) => {
    store.trigger.setSlides({ slides: nextSlides });
  };

  const setPreviewState = (
    updater: SlidePreviewState | ((prev: SlidePreviewState) => SlidePreviewState),
  ) => {
    const current = store.getSnapshot().context.previewState;
    const next = typeof updater === "function" ? updater(current) : updater;
    store.trigger.setPreviewState({ previewState: next });
  };

  const onSlideEventRef = useRef(onSlideEvent);
  useEffect(() => {
    onSlideEventRef.current = onSlideEvent;
  }, [onSlideEvent]);

  const currentSlideIndex = slides.findIndex((slide) => slide.id === previewState.currentSlideId);
  const lastVerticalIndicesRef = useRef<Record<string, number>>({});
  const lastViewedSlideIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!resetBuildStepOnOpen && previewState.currentSlideId) {
      lastViewedSlideIdRef.current = previewState.currentSlideId;
    }
  }, [previewState.currentSlideId, resetBuildStepOnOpen]);

  const handleSlideEvent = (event: SlideEvent) => {
    if (onSlideEventRef.current?.(event) === false) return false;

    setPreviewState((prev) => nextSlidePreviewState(prev, event, { retainSlideOnClose }));

    if (
      !resetBuildStepOnOpen &&
      event.slideId &&
      event.indexv !== undefined &&
      event.indexv !== null
    ) {
      lastVerticalIndicesRef.current[event.slideId] = event.indexv;
    }
    return true;
  };

  // Opens a slide maximized. The state is set here rather than left to the
  // slide_open event, so the slide opens even when onSlideEvent declines it.
  const openAt = (slideId: string, indexv: number) => {
    setPreviewState({
      isOpen: true,
      isMaximized: true,
      currentSlideId: slideId,
      indexv,
    });

    handleSlideEvent({
      type: "slide_open",
      timestamp: performance.now(),
      slideId,
      isMaximized: true,
      indexv,
    });
  };

  const openPresentation = () => {
    if (slides.length === 0) return;

    const rememberedSlide =
      !resetBuildStepOnOpen && lastViewedSlideIdRef.current
        ? slides.find((slide) => slide.id === lastViewedSlideIdRef.current)
        : undefined;
    const targetSlide = rememberedSlide ?? slides[Math.max(currentSlideIndex, 0)] ?? slides[0];
    if (!targetSlide) return;

    const targetIndexv = resetBuildStepOnOpen
      ? 0
      : (lastVerticalIndicesRef.current[targetSlide.id] ?? 0);

    openAt(targetSlide.id, targetIndexv);
  };

  const startPresentation = () => {
    if (slides.length === 0) return;

    openAt(slides[0].id, 0);
  };

  const closePresentation = () => {
    if (previewState.isOpen && previewState.currentSlideId) {
      handleSlideEvent({
        type: "slide_close",
        timestamp: performance.now(),
        slideId: previewState.currentSlideId,
      });
    }

    setPreviewState({
      isOpen: false,
      isMaximized: false,
      currentSlideId: retainSlideOnClose ? previewState.currentSlideId : null,
      indexv: 0,
    });
  };

  return {
    slides,
    previewState,
    currentSlideIndex: Math.max(0, currentSlideIndex),

    setSlides,
    openPresentation,
    startPresentation,
    closePresentation,

    handleSlideEvent,
  };
};

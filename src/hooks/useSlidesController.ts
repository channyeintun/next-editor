import { useRef, useEffect } from "react";
import { useSelector } from "@xstate/store-react";
import type { Slide, SlideEvent, SlidePreviewState } from "../types/slides";
import {
  nextSlidePreviewState,
  selectPreviewState,
  selectSlides,
  type SlidesStoreInstance,
} from "../stores/slidesStore";

interface UseSlidesControllerConfig {
  store: SlidesStoreInstance;
  onSlideEvent?: (event: SlideEvent) => boolean | void;
  retainSlideOnClose?: boolean;
  resetBuildStepOnOpen?: boolean;
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
    const openEvent: SlideEvent = {
      type: "slide_open",
      timestamp: performance.now(),
      slideId,
      isMaximized: true,
      indexv,
    };
    setPreviewState((prev) => nextSlidePreviewState(prev, openEvent, { retainSlideOnClose }));
    handleSlideEvent(openEvent);
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
    const closeEvent: SlideEvent = {
      type: "slide_close",
      timestamp: performance.now(),
      slideId: previewState.currentSlideId ?? undefined,
    };
    if (previewState.isOpen && previewState.currentSlideId) {
      handleSlideEvent(closeEvent);
    }
    // Closes even with nothing to report or when onSlideEvent declined the event; after
    // an applied close this changes nothing, so the store does not emit a second time.
    setPreviewState((prev) => nextSlidePreviewState(prev, closeEvent, { retainSlideOnClose }));
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

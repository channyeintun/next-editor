import { useRef, useEffect } from "react";
import { useSelector } from "@xstate/store-react";
import type { Slide, SlideEvent, SlidePreviewState, SlideContentType } from "../types/slides";
import { selectPreviewState, selectSlides, type SlidesStoreInstance } from "../stores/slidesStore";

interface UseSlidesControllerConfig {
  store: SlidesStoreInstance;
  onSlideEvent?: (event: SlideEvent) => void;
}

export const useSlidesController = ({ store, onSlideEvent }: UseSlidesControllerConfig) => {
  const slides = useSelector(store, (snapshot) => selectSlides(snapshot.context));
  const previewState = useSelector(store, (snapshot) => selectPreviewState(snapshot.context));

  const setSlides = (updater: Slide[] | ((prev: Slide[]) => Slide[])) => {
    const current = store.getSnapshot().context.slides;
    const next = typeof updater === "function" ? updater(current) : updater;
    store.trigger.setSlides({ slides: next });
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
  const slideEventsRef = useRef<SlideEvent[]>([]);
  const lastVerticalIndicesRef = useRef<Record<string, number>>({});
  const lastViewedSlideIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (previewState.currentSlideId) {
      lastViewedSlideIdRef.current = previewState.currentSlideId;
    }
  }, [previewState.currentSlideId]);

  const addSlide = (content: string, contentType: SlideContentType) => {
    const newSlide: Slide = {
      id: Date.now().toString(),
      content: content.trim(),
      contentType,
      order: slides.length,
    };
    setSlides((prev) => [...prev, newSlide]);
    return newSlide;
  };

  const removeSlide = (slideId: string) => {
    setSlides((prev) => {
      const updated = prev
        .filter((slide) => slide.id !== slideId)
        .map((slide, index) => ({ ...slide, order: index }));

      if (previewState.currentSlideId === slideId) {
        if (updated.length > 0) {
          const newIndex = Math.min(currentSlideIndex, updated.length - 1);
          setPreviewState((prevState) => ({
            ...prevState,
            currentSlideId: updated[newIndex]?.id || null,
          }));
        } else {
          setPreviewState((prevState) => ({
            ...prevState,
            isOpen: false,
            currentSlideId: null,
          }));
        }
      }

      return updated;
    });
  };

  const reorderSlides = (newSlides: Slide[]) => {
    setSlides(newSlides);
  };

  const handleSlideEvent = (event: SlideEvent) => {
    slideEventsRef.current.push(event);
    onSlideEventRef.current?.(event);

    switch (event.type) {
      case "slide_open":
        setPreviewState((prev) => {
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
        });
        break;
      case "slide_close":
        setPreviewState((prev) => {
          if (!prev.isOpen && !prev.isMaximized && prev.currentSlideId === null) {
            return prev;
          }
          return {
            ...prev,
            isOpen: false,
            isMaximized: false,
            currentSlideId: null,
            indexv: 0,
          };
        });
        break;
      case "slide_maximize":
        setPreviewState((prev) => {
          if (prev.isMaximized === (event.isMaximized || false)) {
            return prev;
          }
          return { ...prev, isMaximized: event.isMaximized || false };
        });
        break;
      case "slide_minimize":
        setPreviewState((prev) => {
          if (!prev.isMaximized) {
            return prev;
          }
          return { ...prev, isMaximized: false };
        });
        break;
      case "slide_change":
        setPreviewState((prev) => {
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
        });
        break;
      case "slide_interaction":
        setPreviewState((prev) => {
          if (prev.currentInteraction === event.interaction) {
            return prev;
          }
          return {
            ...prev,
            currentInteraction: event.interaction,
          };
        });
        break;
    }

    if (event.slideId && event.indexv !== undefined && event.indexv !== null) {
      lastVerticalIndicesRef.current[event.slideId] = event.indexv;
    }
  };

  const openPresentation = () => {
    if (slides.length === 0) return;

    const rememberedSlide = lastViewedSlideIdRef.current
      ? slides.find((slide) => slide.id === lastViewedSlideIdRef.current)
      : undefined;
    const targetSlide = rememberedSlide ?? slides[Math.max(currentSlideIndex, 0)] ?? slides[0];
    if (!targetSlide) return;

    const targetIndexv = lastVerticalIndicesRef.current[targetSlide.id] ?? 0;

    setPreviewState({
      isOpen: true,
      isMaximized: true,
      currentSlideId: targetSlide.id,
      indexv: targetIndexv,
    });

    handleSlideEvent({
      type: "slide_open",
      timestamp: performance.now(),
      slideId: targetSlide.id,
      isMaximized: true,
      indexv: targetIndexv,
    });
  };

  const startPresentation = () => {
    if (slides.length === 0) return;

    setPreviewState({
      isOpen: true,
      isMaximized: true,
      currentSlideId: slides[0].id,
      indexv: 0,
    });

    handleSlideEvent({
      type: "slide_open",
      timestamp: performance.now(),
      slideId: slides[0].id,
      isMaximized: true,
      indexv: 0,
    });
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
      currentSlideId: null,
      indexv: 0,
    });
  };

  const goToSlide = (index: number, indexv?: number) => {
    if (index >= 0 && index < slides.length) {
      const slideId = slides[index].id;
      const targetIndexv = indexv ?? lastVerticalIndicesRef.current[slideId] ?? 0;

      setPreviewState((prev) => ({
        ...prev,
        currentSlideId: slideId,
        indexv: targetIndexv,
      }));
    }
  };

  const clearSlideEvents = () => {
    slideEventsRef.current = [];
  };

  const getSlideEvents = () => {
    return [...slideEventsRef.current];
  };

  return {
    slides,
    previewState,
    currentSlideIndex: Math.max(0, currentSlideIndex),

    addSlide,
    removeSlide,
    reorderSlides,
    setSlides,
    setPreviewState,
    openPresentation,
    startPresentation,
    closePresentation,
    goToSlide,

    handleSlideEvent,
    clearSlideEvents,
    getSlideEvents,
  };
};

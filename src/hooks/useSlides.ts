import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Slide, SlidePreviewState, SlideEvent, SlideContentType } from "../types/slides";

const SLIDES_STORAGE_KEY = "next-editor-slides";

// Type guard for Slide
const isSlide = (item: unknown): item is Slide => {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as { [K in keyof Slide]?: unknown };
  return (
    typeof obj.id === "string" &&
    typeof obj.content === "string" &&
    typeof obj.order === "number" &&
    (obj.contentType === "html" || obj.contentType === "markdown" || obj.contentType === undefined)
  );
};

// Load slides from localStorage
const loadSlidesFromStorage = (): Slide[] => {
  try {
    const saved = localStorage.getItem(SLIDES_STORAGE_KEY);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        // Validate and migrate slides
        return parsed.filter(isSlide).map((slide) => ({
          ...slide,
          contentType: slide.contentType ?? "html", // Migrate old slides missing contentType
        }));
      }
    }
  } catch (e) {
    console.error("Failed to load slides from localStorage:", e);
  }
  return [];
};

// Save slides to localStorage
const saveSlidesToStorage = (slides: Slide[]): void => {
  try {
    localStorage.setItem(SLIDES_STORAGE_KEY, JSON.stringify(slides));
  } catch (e) {
    console.error("Failed to save slides to localStorage:", e);
  }
};

interface UseSlidesConfig {
  onSlideEvent?: (event: SlideEvent) => void;
}

export const useSlides = ({ onSlideEvent }: UseSlidesConfig = {}) => {
  const [slides, setSlides] = useState<Slide[]>(loadSlidesFromStorage);
  const [previewState, setPreviewState] = useState<SlidePreviewState>({
    isOpen: false,
    isMaximized: false,
    currentSlideId: null,
    indexv: 0,
  });

  // Use a ref for onSlideEvent to keep handleSlideEvent stable
  const onSlideEventRef = useRef(onSlideEvent);
  useEffect(() => {
    onSlideEventRef.current = onSlideEvent;
  }, [onSlideEvent]);

  const currentSlideIndex = slides.findIndex((slide) => slide.id === previewState.currentSlideId);
  const slideEventsRef = useRef<SlideEvent[]>([]);
  const lastVerticalIndicesRef = useRef<Record<string, number>>({});
  const lastViewedSlideIdRef = useRef<string | null>(null);

  // Persist slides to localStorage whenever they change
  useEffect(() => {
    saveSlidesToStorage(slides);
  }, [slides]);

  useEffect(() => {
    if (previewState.currentSlideId) {
      lastViewedSlideIdRef.current = previewState.currentSlideId;
    }
  }, [previewState.currentSlideId]);

  const addSlide = useCallback(
    (content: string, contentType: SlideContentType) => {
      const newSlide: Slide = {
        id: Date.now().toString(),
        content: content.trim(),
        contentType,
        order: slides.length,
      };
      setSlides((prev) => [...prev, newSlide]);
      return newSlide;
    },
    [slides.length],
  );

  const removeSlide = useCallback(
    (slideId: string) => {
      setSlides((prev) => {
        const updated = prev
          .filter((slide) => slide.id !== slideId)
          .map((slide, index) => ({ ...slide, order: index }));

        // If we're removing the current slide, close preview or move to another slide
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
    },
    [previewState.currentSlideId, currentSlideIndex],
  );

  const reorderSlides = useCallback((newSlides: Slide[]) => {
    setSlides(newSlides);
  }, []);

  const handleSlideEvent = useCallback((event: SlideEvent) => {
    slideEventsRef.current.push(event);
    onSlideEventRef.current?.(event);

    // Update preview state based on event
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

    // Capture vertical index if provided to maintain memory per slide
    if (event.slideId && event.indexv !== undefined && event.indexv !== null) {
      lastVerticalIndicesRef.current[event.slideId] = event.indexv;
    }
  }, []);

  const openPresentation = useCallback(() => {
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
  }, [slides, currentSlideIndex, handleSlideEvent]);

  const startPresentation = useCallback(() => {
    if (slides.length === 0) return;

    setPreviewState({
      isOpen: true,
      isMaximized: true,
      currentSlideId: slides[0].id,
      indexv: 0,
    });

    // Emit open event after setting state
    handleSlideEvent({
      type: "slide_open",
      timestamp: performance.now(),
      slideId: slides[0].id,
      isMaximized: true,
      indexv: 0,
    });
  }, [slides, handleSlideEvent]);

  const closePresentation = useCallback(() => {
    // Emit close event before closing
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
  }, [previewState.isOpen, previewState.currentSlideId, handleSlideEvent]);

  const goToSlide = useCallback(
    (index: number, indexv?: number) => {
      if (index >= 0 && index < slides.length) {
        const slideId = slides[index].id;
        const targetIndexv = indexv ?? lastVerticalIndicesRef.current[slideId] ?? 0;

        setPreviewState((prev) => ({
          ...prev,
          currentSlideId: slideId,
          indexv: targetIndexv,
        }));
      }
    },
    [slides],
  );

  const clearSlideEvents = useCallback(() => {
    slideEventsRef.current = [];
  }, []);

  const getSlideEvents = useCallback(() => {
    return [...slideEventsRef.current];
  }, []);

  return useMemo(
    () => ({
      // State
      slides,
      previewState,
      currentSlideIndex: Math.max(0, currentSlideIndex),

      // Actions
      addSlide,
      removeSlide,
      reorderSlides,
      setSlides,
      setPreviewState,
      openPresentation,
      startPresentation,
      closePresentation,
      goToSlide,

      // Event handling
      handleSlideEvent,
      clearSlideEvents,
      getSlideEvents,
    }),
    [
      slides,
      previewState,
      currentSlideIndex,
      addSlide,
      removeSlide,
      reorderSlides,
      startPresentation,
      openPresentation,
      closePresentation,
      goToSlide,
      handleSlideEvent,
      clearSlideEvents,
      getSlideEvents,
    ],
  );
};

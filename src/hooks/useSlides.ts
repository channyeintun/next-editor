import { useState, useCallback, useRef, useEffect } from 'react';
import type { Slide, SlidePreviewState, SlideEvent } from '../types/slides';

const SLIDES_STORAGE_KEY = 'next-editor-slides';

// Load slides from localStorage
const loadSlidesFromStorage = (): Slide[] => {
  try {
    const saved = localStorage.getItem(SLIDES_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load slides from localStorage:', e);
  }
  return [];
};

// Save slides to localStorage
const saveSlidesToStorage = (slides: Slide[]): void => {
  try {
    localStorage.setItem(SLIDES_STORAGE_KEY, JSON.stringify(slides));
  } catch (e) {
    console.warn('Failed to save slides to localStorage:', e);
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
    currentSlideId: null
  });

  const currentSlideIndex = slides.findIndex(slide => slide.id === previewState.currentSlideId);
  const slideEventsRef = useRef<SlideEvent[]>([]);

  // Persist slides to localStorage whenever they change
  useEffect(() => {
    saveSlidesToStorage(slides);
  }, [slides]);

  const addSlide = useCallback((imageUrl: string) => {
    const newSlide: Slide = {
      id: Date.now().toString(),
      imageUrl: imageUrl.trim(),
      order: slides.length,
    };
    setSlides(prev => [...prev, newSlide]);
    return newSlide;
  }, [slides.length]);

  const removeSlide = useCallback((slideId: string) => {
    setSlides(prev => {
      const updated = prev
        .filter(slide => slide.id !== slideId)
        .map((slide, index) => ({ ...slide, order: index }));

      // If we're removing the current slide, close preview or move to another slide
      if (previewState.currentSlideId === slideId) {
        if (updated.length > 0) {
          const newIndex = Math.min(currentSlideIndex, updated.length - 1);
          setPreviewState(prevState => ({
            ...prevState,
            currentSlideId: updated[newIndex]?.id || null
          }));
        } else {
          setPreviewState(prevState => ({
            ...prevState,
            isOpen: false,
            currentSlideId: null
          }));
        }
      }

      return updated;
    });
  }, [previewState.currentSlideId, currentSlideIndex]);

  const reorderSlides = useCallback((newSlides: Slide[]) => {
    setSlides(newSlides);
  }, []);

  const handleSlideEvent = useCallback((event: SlideEvent) => {
    slideEventsRef.current.push(event);
    onSlideEvent?.(event);

    // Update preview state based on event
    switch (event.type) {
      case 'slide_open':
        setPreviewState(prev => ({
          ...prev,
          isOpen: true,
          currentSlideId: event.slideId || prev.currentSlideId
        }));
        break;
      case 'slide_close':
        setPreviewState(prev => ({
          ...prev,
          isOpen: false,
          isMaximized: false,
          currentSlideId: null
        }));
        break;
      case 'slide_maximize':
        setPreviewState(prev => ({ ...prev, isMaximized: event.isMaximized || false }));
        break;
      case 'slide_minimize':
        setPreviewState(prev => ({ ...prev, isMaximized: false }));
        break;
    }
  }, [onSlideEvent]);

  const startPresentation = useCallback(() => {
    if (slides.length === 0) return;

    setPreviewState({
      isOpen: true,
      isMaximized: false,
      currentSlideId: slides[0].id
    });

    // Emit open event after setting state
    handleSlideEvent({
      type: 'slide_open',
      timestamp: performance.now(),
      slideId: slides[0].id
    });
  }, [slides, handleSlideEvent]);

  const closePresentation = useCallback(() => {
    // Emit close event before closing
    if (previewState.isOpen && previewState.currentSlideId) {
      handleSlideEvent({
        type: 'slide_close',
        timestamp: performance.now(),
        slideId: previewState.currentSlideId
      });
    }

    setPreviewState({
      isOpen: false,
      isMaximized: false,
      currentSlideId: null
    });
  }, [previewState.isOpen, previewState.currentSlideId, handleSlideEvent]);

  const goToSlide = useCallback((index: number) => {
    if (index >= 0 && index < slides.length) {
      setPreviewState(prev => ({
        ...prev,
        currentSlideId: slides[index].id
      }));
    }
  }, [slides]);

  const clearSlideEvents = useCallback(() => {
    slideEventsRef.current = [];
  }, []);

  const getSlideEvents = useCallback(() => {
    return [...slideEventsRef.current];
  }, []);

  return {
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
    startPresentation,
    closePresentation,
    goToSlide,

    // Event handling
    handleSlideEvent,
    clearSlideEvents,
    getSlideEvents,
  };
};
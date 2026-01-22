import React, { createContext, useContext, useEffect, useCallback } from 'react';
import { useSlides } from '../hooks/useSlides';
import { useNextEditorActions } from '../hooks/useNextEditorContext';
import type { SlidePreviewState } from '../types/slides';

const SlidesContext = createContext<ReturnType<typeof useSlides> | null>(null);

interface SlidesProviderProps {
  children: React.ReactNode;
}

export const SlidesProvider: React.FC<SlidesProviderProps> = ({ children }) => {
  const {
    handleSlideEvent,
    registerSlideStateGetter,
    registerSlideStateApplier,
    registerSlidesGetter,
    registerSlidesApplier,
    navigateSlidesDirect,
  } = useNextEditorActions();

  const slidesData = useSlides({
    onSlideEvent: handleSlideEvent
  });

  // Register slide state getter and applier with NextEditorProvider
  const slideStateGetter = useCallback(() => ({
    previewState: slidesData.previewState,
    currentSlideIndex: slidesData.currentSlideIndex
  }), [slidesData.previewState, slidesData.currentSlideIndex]);

  useEffect(() => {
    if (registerSlideStateGetter && typeof registerSlideStateGetter === 'function') {
      registerSlideStateGetter(slideStateGetter);
    }
  }, [registerSlideStateGetter, slideStateGetter]);

  // Register slides data getter with NextEditorProvider
  const slidesGetter = useCallback(() => slidesData.slides, [slidesData.slides]);

  useEffect(() => {
    if (registerSlidesGetter && typeof registerSlidesGetter === 'function') {
      registerSlidesGetter(slidesGetter);
    }
  }, [registerSlidesGetter, slidesGetter]);

  const slideStateApplier = useCallback((slideState: SlidePreviewState, currentSlideIndex: number) => {
    // Directly apply the slide state during playback without triggering events
    // to avoid double event recording during playback

    // Set the preview state directly to match the recorded state
    slidesData.setPreviewState(prev => {
      const nextIsOpen = slideState.isOpen;
      const nextIsMaximized = slideState.isMaximized ?? prev.isMaximized ?? false;
      const nextSlideId = slideState.currentSlideId ?? prev.currentSlideId ?? null;
      // Preserve the current vertical index if slideState.indexv is undefined
      const nextIndexv = slideState.indexv ?? prev.indexv ?? 0;
      const nextInteraction = slideState.currentInteraction;

      if (nextIsOpen !== prev.isOpen ||
        nextIsMaximized !== prev.isMaximized ||
        nextSlideId !== prev.currentSlideId ||
        nextIndexv !== prev.indexv ||
        nextInteraction !== prev.currentInteraction) {

        return {
          isOpen: nextIsOpen,
          isMaximized: nextIsMaximized,
          currentSlideId: nextSlideId,
          indexv: nextIndexv,
          currentInteraction: nextInteraction
        };
      }
      return prev;
    });

    // Update slide index if needed
    if (slideState.isOpen) {
      const nextIndexv = slideState.indexv ?? slidesData.previewState.indexv ?? 0;
      const prevIndexv = slidesData.previewState.indexv ?? 0;

      if (currentSlideIndex !== slidesData.currentSlideIndex || (slideState.indexv !== undefined && nextIndexv !== prevIndexv)) {
        // ALWAYS use direct navigation for playback events to ensure sequential processing
        // even if React batches the state updates below.
        if (navigateSlidesDirect) {
          navigateSlidesDirect(currentSlideIndex, nextIndexv);
        }
      }
    }
  }, [slidesData, navigateSlidesDirect]); // Added navigateSlidesDirect to dependencies

  useEffect(() => {
    if (registerSlideStateApplier && typeof registerSlideStateApplier === 'function') {
      registerSlideStateApplier(slideStateApplier);
    }
  }, [registerSlideStateApplier, slideStateApplier]);

  const slidesApplier = useCallback((slides: Array<{ id: string; content: string; contentType: 'html' | 'markdown'; name?: string; order: number }>) => {
    slidesData.setSlides(slides);
  }, [slidesData]);

  useEffect(() => {
    if (registerSlidesApplier && typeof registerSlidesApplier === 'function') {
      registerSlidesApplier(slidesApplier);
    }
  }, [registerSlidesApplier, slidesApplier]);

  return (
    <SlidesContext.Provider value={slidesData}>
      {children}
    </SlidesContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useSlidesContext = () => {
  const context = useContext(SlidesContext);
  if (!context) {
    throw new Error('useSlidesContext must be used within a SlidesProvider');
  }
  return context;
};
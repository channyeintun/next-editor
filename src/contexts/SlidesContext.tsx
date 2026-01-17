import React, { createContext, useContext, useEffect, useCallback } from 'react';
import { useSlides } from '../hooks/useSlides';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import type { SlidePreviewState } from '../types/slides';

const SlidesContext = createContext<ReturnType<typeof useSlides> | null>(null);

interface SlidesProviderProps {
  children: React.ReactNode;
}

export const SlidesProvider: React.FC<SlidesProviderProps> = ({ children }) => {
  const nextEditorContext = useNextEditorContext();
  const { handleSlideEvent } = nextEditorContext;
  const registerSlideStateGetter = 'registerSlideStateGetter' in nextEditorContext ? nextEditorContext.registerSlideStateGetter : undefined;
  const registerSlideStateApplier = 'registerSlideStateApplier' in nextEditorContext ? nextEditorContext.registerSlideStateApplier : undefined;
  const registerSlidesGetter = 'registerSlidesGetter' in nextEditorContext ? nextEditorContext.registerSlidesGetter : undefined;
  const registerSlidesApplier = 'registerSlidesApplier' in nextEditorContext ? nextEditorContext.registerSlidesApplier : undefined;

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
    if (slideState.isOpen !== slidesData.previewState.isOpen ||
      slideState.isMaximized !== slidesData.previewState.isMaximized ||
      slideState.currentSlideId !== slidesData.previewState.currentSlideId) {

      slidesData.setPreviewState({
        isOpen: slideState.isOpen,
        isMaximized: slideState.isMaximized,
        currentSlideId: slideState.currentSlideId
      });
    }

    // Update slide index if needed
    if (slideState.isOpen && currentSlideIndex !== slidesData.currentSlideIndex) {
      slidesData.goToSlide(currentSlideIndex);
    }
  }, [slidesData]); // slidesData is stable because of useMemo in useSlides

  useEffect(() => {
    if (registerSlideStateApplier && typeof registerSlideStateApplier === 'function') {
      registerSlideStateApplier(slideStateApplier);
    }
  }, [registerSlideStateApplier, slideStateApplier]);

  const slidesApplier = useCallback((slides: Array<{ id: string; imageUrl: string; name?: string; order: number }>) => {
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
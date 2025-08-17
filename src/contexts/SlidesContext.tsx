import React, { createContext, useContext, useEffect } from 'react';
import { useSlides } from '../hooks/useSlides';
import { useScrimbaContext } from '../hooks/useScrimbaContext';
import type { SlidePreviewState } from '../types/slides';

const SlidesContext = createContext<ReturnType<typeof useSlides> | null>(null);

interface SlidesProviderProps {
  children: React.ReactNode;
}

export const SlidesProvider: React.FC<SlidesProviderProps> = ({ children }) => {
  const scrimbaContext = useScrimbaContext();
  const { handleSlideEvent } = scrimbaContext;
  const registerSlideStateGetter = 'registerSlideStateGetter' in scrimbaContext ? scrimbaContext.registerSlideStateGetter : undefined;
  const registerSlideStateApplier = 'registerSlideStateApplier' in scrimbaContext ? scrimbaContext.registerSlideStateApplier : undefined;
  
  const slidesData = useSlides({
    onSlideEvent: handleSlideEvent
  });

  // Register slide state getter and applier with ScrimbaProvider
  useEffect(() => {
    if (registerSlideStateGetter && typeof registerSlideStateGetter === 'function') {
      registerSlideStateGetter(() => ({
        previewState: slidesData.previewState,
        currentSlideIndex: slidesData.currentSlideIndex
      }));
    }
  }, [registerSlideStateGetter, slidesData.previewState, slidesData.currentSlideIndex]);

  useEffect(() => {
    if (registerSlideStateApplier && typeof registerSlideStateApplier === 'function') {
      registerSlideStateApplier((slideState: SlidePreviewState, currentSlideIndex: number) => {
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
      });
    }
  }, [registerSlideStateApplier, slidesData]);

  return (
    <SlidesContext.Provider value={slidesData}>
      {children}
    </SlidesContext.Provider>
  );
};

export const useSlidesContext = () => {
  const context = useContext(SlidesContext);
  if (!context) {
    throw new Error('useSlidesContext must be used within a SlidesProvider');
  }
  return context;
};
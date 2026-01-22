import { memo } from 'react';
import { useSlidesContext } from '../contexts/SlidesContext';
import { useNextEditorActions } from '../hooks/useNextEditorContext';
import SlidePreview from './SlidePreview';

export default memo(function SlidePanel() {
  const {
    slides,
    previewState,
    currentSlideIndex,
    goToSlide,
    handleSlideEvent: onSlideEvent,
  } = useSlidesContext();

  const { registerSlideNavigator, pause } = useNextEditorActions();

  return (
    <>
      {/* Slide Preview */}
      <SlidePreview
        slides={slides}
        currentSlideIndex={currentSlideIndex}
        onSlideChange={goToSlide}
        onSlideEvent={onSlideEvent}
        onStopPlayback={pause}
        isOpen={previewState.isOpen}
        isMaximized={previewState.isMaximized}
        verticalIndex={previewState.indexv}
        currentInteraction={previewState.currentInteraction}
        registerSlideNavigator={registerSlideNavigator}
        positioning="fixed"
      />
    </>
  );
});
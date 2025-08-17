import { useSlidesContext } from '../contexts/SlidesContext';
import { useScrimbaContext } from '../hooks/useScrimbaContext';
import SlidePreview from './SlidePreview';

export default function SlidePanel() {
  const {
    slides,
    previewState,
    currentSlideIndex,
    goToSlide,
    handleSlideEvent: onSlideEvent,
  } = useSlidesContext();
  
  const { pause } = useScrimbaContext();

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
        positioning="fixed"
      />
    </>
  );
}
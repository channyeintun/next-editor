import { useSlidesContext } from '../contexts/SlidesContext';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import SlidePreview from './SlidePreview';

export default function SlidePanel() {
  const {
    slides,
    previewState,
    currentSlideIndex,
    goToSlide,
    handleSlideEvent: onSlideEvent,
  } = useSlidesContext();

  const nextEditorContext = useNextEditorContext();
  const registerSlideNavigator = 'registerSlideNavigator' in nextEditorContext ? nextEditorContext.registerSlideNavigator : undefined;

  const { pause } = useNextEditorContext();

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
}
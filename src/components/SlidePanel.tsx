import { useNextEditorDomainAdapters } from "../contexts/NextEditorDomainAdaptersContext";
import { useSlidesContext } from "../contexts/SlidesContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import SlidePreview from "./SlidePreview";

export default function SlidePanel() {
  const {
    slides,
    previewState,
    currentSlideIndex,
    goToSlide,
    closePresentation,
    handleSlideEvent: onSlideEvent,
  } = useSlidesContext();
  const { slides: slidesAdapter } = useNextEditorDomainAdapters();

  const { pause } = useNextEditorActions();
  const isPresentationVisible = previewState.isOpen && previewState.isMaximized === true;

  return (
    <>
      {/* Slide Preview */}
      <SlidePreview
        slides={slides}
        currentSlideIndex={currentSlideIndex}
        onSlideChange={goToSlide}
        onSlideEvent={onSlideEvent}
        onStopPlayback={pause}
        onClose={closePresentation}
        isOpen={isPresentationVisible}
        isMaximized={previewState.isMaximized}
        verticalIndex={previewState.indexv}
        currentInteraction={previewState.currentInteraction}
        setSlideNavigator={slidesAdapter.setNavigator}
        positioning="fixed"
      />
    </>
  );
}

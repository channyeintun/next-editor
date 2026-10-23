import { useSlidesContext } from "../contexts/SlidesContext";
import SlidePreview from "./SlidePreview";

export default function SlidePanel() {
  const {
    slides,
    previewState,
    currentSlideIndex,
    closePresentation,
    handleSlideEvent: onSlideEvent,
  } = useSlidesContext();

  const isPresentationVisible = previewState.isOpen && previewState.isMaximized === true;

  return (
    <>
      {/* Slide Preview */}
      <SlidePreview
        slides={slides}
        currentSlideIndex={currentSlideIndex}
        onSlideEvent={onSlideEvent}
        onClose={closePresentation}
        isOpen={isPresentationVisible}
        verticalIndex={previewState.indexv}
        positioning="fixed"
      />
    </>
  );
}

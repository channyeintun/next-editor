import { useSlidesContext } from "../contexts/SlidesContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import SlidePreview from "./SlidePreview";

export default function SlidePanel() {
  const {
    slides,
    previewState,
    currentSlideIndex,
    closePresentation,
    handleSlideEvent: onSlideEvent,
  } = useSlidesContext();

  const { pause } = useNextEditorActions();
  const isPresentationVisible = previewState.isOpen && previewState.isMaximized === true;

  return (
    <>
      {/* Slide Preview */}
      <SlidePreview
        slides={slides}
        currentSlideIndex={currentSlideIndex}
        onSlideEvent={onSlideEvent}
        onStopPlayback={pause}
        onClose={closePresentation}
        isOpen={isPresentationVisible}
        verticalIndex={previewState.indexv}
        positioning="fixed"
      />
    </>
  );
}

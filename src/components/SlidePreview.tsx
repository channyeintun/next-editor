import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Keyboard } from "lucide-react";
import type { Slide, SlideEvent } from "../types/slides";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import CustomSlideRenderer from "./CustomSlideRenderer";

interface SlidePreviewProps {
  slides: Slide[];
  currentSlideIndex: number;
  onSlideChange: (indexh: number, indexv?: number) => void;
  onSlideEvent?: (event: SlideEvent) => void;
  onStopPlayback?: () => void;
  onClose?: () => void;
  isOpen: boolean;
  isMaximized?: boolean;
  verticalIndex?: number;
  positioning?: "fixed" | "relative" | "absolute" | "sticky";
}

function SlidePreview({
  slides,
  currentSlideIndex,
  onSlideChange,
  onSlideEvent,
  onStopPlayback,
  onClose,
  isOpen,
  verticalIndex = 0,
  positioning = "fixed",
}: SlidePreviewProps) {
  const { isPlaying } = useNextEditorMetadata();
  // Check record mode from sessionStorage
  const recordMode = sessionStorage.getItem("recordMode") === "true";

  const onSlideEventRef = useRef(onSlideEvent);
  onSlideEventRef.current = onSlideEvent;

  const currentSlide = slides[currentSlideIndex];

  const emitSlideEvent = (
    type: SlideEvent["type"],
    slideId?: string,
    isMaximizedState?: boolean,
    indexv?: number,
  ) => {
    onSlideEventRef.current?.({
      type,
      timestamp: performance.now(),
      slideId,
      isMaximized: isMaximizedState,
      indexv,
    });
  };

  const handleClose = () => {
    onClose?.();
    onStopPlayback?.();
  };

  // Handle messages from html slides that embed an iframe with the shared
  // interaction-capture script (see src/utils/iframeInteractionCapture.ts) —
  // unrelated to the slide renderer itself.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (isPlaying) return;

      const { type, payload } = event.data || {};
      if (type === "IFRAME_INTERACTION") {
        const interaction = {
          type: payload.type,
          timestamp: performance.now(),
          target: payload.target,
          data: payload.data,
        };

        // Send the interaction event without stale position data
        onSlideEventRef.current?.({
          type: "slide_interaction",
          timestamp: performance.now(),
          slideId: currentSlide?.id,
          interaction,
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [isPlaying, currentSlide?.id]);

  // Number of build steps on a slide (0 for html/markdown slides).
  const stepCountOf = (slide?: Slide): number =>
    slide?.contentType === "google-svg" ? (slide.steps?.length ?? 0) : 0;

  const isFirst = currentSlideIndex === 0 && verticalIndex === 0;
  const isLast =
    currentSlideIndex === slides.length - 1 && verticalIndex >= stepCountOf(currentSlide);

  const goToNextSlide = () => {
    if (isPlaying) return;

    // Reveal the next build step of the current slide before advancing.
    const currentStepCount = stepCountOf(currentSlide);
    if (currentStepCount > 0 && verticalIndex < currentStepCount) {
      const nextIndexv = verticalIndex + 1;
      onSlideChange(currentSlideIndex, nextIndexv);
      emitSlideEvent("slide_change", currentSlide?.id, true, nextIndexv);
      return;
    }

    if (currentSlideIndex < slides.length - 1) {
      const newIndex = currentSlideIndex + 1;
      onSlideChange(newIndex, 0); // New slide starts with no steps revealed.
      emitSlideEvent("slide_change", slides[newIndex]?.id, true, 0);
    }
  };

  const goToPrevSlide = () => {
    if (isPlaying) return;

    // Hide the last revealed build step of the current slide first.
    if (stepCountOf(currentSlide) > 0 && verticalIndex > 0) {
      const nextIndexv = verticalIndex - 1;
      onSlideChange(currentSlideIndex, nextIndexv);
      emitSlideEvent("slide_change", currentSlide?.id, true, nextIndexv);
      return;
    }

    if (currentSlideIndex > 0) {
      const newIndex = currentSlideIndex - 1;
      // Land on the previous slide fully revealed so back-stepping is symmetric.
      const prevIndexv = stepCountOf(slides[newIndex]);
      onSlideChange(newIndex, prevIndexv);
      emitSlideEvent("slide_change", slides[newIndex]?.id, true, prevIndexv);
    }
  };

  // Keyboard navigation while the slide preview is open.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          goToPrevSlide();
          break;
        case "ArrowRight":
          e.preventDefault();
          goToNextSlide();
          break;
        case "Escape":
          e.preventDefault();
          handleClose();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, goToPrevSlide, goToNextSlide, handleClose]);

  if (!isOpen || !currentSlide) {
    return null;
  }

  const isNavigationEnabled = !isPlaying;

  return (
    <>
      <div
        className="fixed inset-0 z-90 backdrop-blur-md opacity-0 animate-[fade-in_0.2s_ease-out_forwards] motion-reduce:animate-none motion-reduce:opacity-100"
        onClick={handleClose}
      />

      <div
        className={`${positioning} top-[10%] left-[10%] right-[10%] bottom-[10%] z-100 bg-slate-900 rounded-2xl overflow-hidden flex flex-col shadow-2xl transition-shadow size-[80%]`}
        data-cursor-replay-target="slide-preview"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {/* Slide content area */}
        <div
          className="relative w-full flex-1 bg-black"
          data-cursor-replay-target="slide-content"
          onClick={(e) => e.stopPropagation()}
        >
          <CustomSlideRenderer
            slides={slides}
            currentSlideIndex={currentSlideIndex}
            currentVerticalIndex={verticalIndex}
          />

          {isNavigationEnabled && (slides.length > 1 || stepCountOf(currentSlide) > 0) && (
            <>
              <button
                type="button"
                onClick={goToPrevSlide}
                disabled={isFirst}
                aria-label="Previous slide"
                className="absolute left-4 top-1/2 -translate-y-1/2 flex size-10 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronLeft className="size-5" />
              </button>
              <button
                type="button"
                onClick={goToNextSlide}
                disabled={isLast}
                aria-label="Next slide"
                className="absolute right-4 top-1/2 -translate-y-1/2 flex size-10 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          )}

          {/* Slide counter */}
          <div className="absolute bottom-4 right-4 rounded-full bg-black/40 px-3 py-1 text-xs font-medium text-white/80">
            {currentSlideIndex + 1} / {slides.length}
          </div>

          {/* Keyboard navigation hint */}
          {recordMode && (
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 flex items-center gap-3 bg-slate-900 border border-white/10 px-4 py-2 rounded-2xl shadow-2xl opacity-0 hover:opacity-100 transition-opacity duration-500 pointer-events-none">
              <div className="p-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/20">
                <Keyboard className="text-indigo-400 size-4" />
              </div>
              <span className="text-xs font-bold text-slate-200">Use Arrow Keys to Navigate</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default SlidePreview;

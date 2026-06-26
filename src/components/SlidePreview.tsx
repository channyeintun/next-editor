import { useEffect, useRef } from "react";
import { Keyboard } from "lucide-react";
import type { Slide, SlideEvent } from "../types/slides";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import RevealSlideRenderer from "./RevealSlideRenderer";

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
  currentInteraction?: import("../types/slides").IframeInteractionEvent;
  setSlideNavigator?: (navigator: (indexh: number, indexv: number) => void) => void;
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
  currentInteraction,
  setSlideNavigator,
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

  const handleSlideChangeFromReveal = (indexh: number, indexv?: number) => {
    if (isPlaying) return;
    onSlideChange(indexh, indexv);
    if (slides[indexh]) {
      emitSlideEvent("slide_change", slides[indexh].id, true, indexv);
    }
  };

  // Handle messages from the Reveal iframe
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

  const goToNextSlide = () => {
    if (isPlaying) return;
    if (currentSlideIndex < slides.length - 1) {
      const newIndex = currentSlideIndex + 1;
      onSlideChange(newIndex); // Leave indexv undefined to use memory
      emitSlideEvent("slide_change", slides[newIndex]?.id, true);
    }
  };

  const goToPrevSlide = () => {
    if (isPlaying) return;
    if (currentSlideIndex > 0) {
      const newIndex = currentSlideIndex - 1;
      onSlideChange(newIndex); // Leave indexv undefined to use memory
      emitSlideEvent("slide_change", slides[newIndex]?.id, true);
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

  return (
    <>
      <div
        className="fixed inset-0 z-90 bg-black/80 backdrop-blur-md opacity-0 animate-[fade-in_0.2s_ease-out_forwards] motion-reduce:animate-none motion-reduce:opacity-100"
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
          <RevealSlideRenderer
            slides={slides}
            currentSlideIndex={currentSlideIndex}
            currentVerticalIndex={verticalIndex}
            currentInteraction={currentInteraction}
            onSlideChange={handleSlideChangeFromReveal}
            isNavigationEnabled={!isPlaying}
            setSlideNavigator={setSlideNavigator}
          />

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

import { motion, type Transition } from "motion/react";
import { useCallback, useEffect, memo, useRef } from "react";
import { ChevronLeft, ChevronRight, Monitor, Keyboard, X } from "lucide-react";
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

const SlidePreview = memo(function SlidePreview({
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

  const emitSlideEvent = useCallback(
    (type: SlideEvent["type"], slideId?: string, isMaximizedState?: boolean, indexv?: number) => {
      onSlideEventRef.current?.({
        type,
        timestamp: performance.now(),
        slideId,
        isMaximized: isMaximizedState,
        indexv,
      });
    },
    [],
  );

  const handleClose = useCallback(() => {
    onClose?.();
    onStopPlayback?.();
  }, [onClose, onStopPlayback]);

  const handleSlideChangeFromReveal = useCallback(
    (indexh: number, indexv?: number) => {
      if (isPlaying) return;
      onSlideChange(indexh, indexv);
      if (slides[indexh]) {
        emitSlideEvent("slide_change", slides[indexh].id, true, indexv);
      }
    },
    [isPlaying, onSlideChange, slides, emitSlideEvent],
  );

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

  const goToNextSlide = useCallback(() => {
    if (isPlaying) return;
    if (currentSlideIndex < slides.length - 1) {
      const newIndex = currentSlideIndex + 1;
      onSlideChange(newIndex); // Leave indexv undefined to use memory
      emitSlideEvent("slide_change", slides[newIndex]?.id, true);
    }
  }, [isPlaying, currentSlideIndex, slides, onSlideChange, emitSlideEvent]);

  const goToPrevSlide = useCallback(() => {
    if (isPlaying) return;
    if (currentSlideIndex > 0) {
      const newIndex = currentSlideIndex - 1;
      onSlideChange(newIndex); // Leave indexv undefined to use memory
      emitSlideEvent("slide_change", slides[newIndex]?.id, true);
    }
  }, [isPlaying, currentSlideIndex, onSlideChange, emitSlideEvent, slides]);

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

  const layoutTransition: Transition = {
    type: "spring",
    stiffness: 300,
    damping: 30,
    mass: 0.8,
  };

  // Transition already defined above

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-90 bg-black/80"
        onClick={handleClose}
      />

      <motion.div
        layout
        transition={layoutTransition}
        style={{
          transformOrigin: "bottom right",
          willChange: "transform",
        }}
        className={`${positioning} top-[10%] left-[10%] right-[10%] bottom-[10%] z-100 bg-slate-900 rounded-2xl overflow-hidden border border-white/10 flex flex-col shadow-2xl transition-shadow size-[80%]`}
        data-cursor-replay-target="slide-preview"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {/* Header */}
        <div className="flex items-center bg-slate-900 px-4 py-2 border-b border-white/5">
          <div className="flex items-center gap-2 mr-4">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              className="inline-flex items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-white size-7"
              title="Close slides"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="rounded bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 size-5">
              <Monitor className="text-indigo-400 size-3" />
            </div>
            <span className="text-[11px] font-bold text-slate-300 tracking-tight uppercase">
              Slide {currentSlideIndex + 1}{" "}
              <span className="text-slate-500">of {slides.length}</span>
            </span>
          </div>

          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={(e) => {
                e.stopPropagation();
                goToPrevSlide();
              }}
              disabled={currentSlideIndex === 0 || isPlaying}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg disabled:opacity-20 transition-all"
              title="Previous slide"
            >
              <ChevronLeft className="size-4" />
            </button>
            <div className="w-px h-4 bg-white/5 mx-1"></div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                goToNextSlide();
              }}
              disabled={currentSlideIndex === slides.length - 1 || isPlaying}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg disabled:opacity-20 transition-all"
              title="Next slide"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>

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
      </motion.div>
    </>
  );
});

export default SlidePreview;

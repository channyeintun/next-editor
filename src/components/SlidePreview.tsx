import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Keyboard, Minimize2, RefreshCw, X } from "lucide-react";
import type { Slide, SlideEvent } from "../types/slides";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import CustomSlideRenderer from "./CustomSlideRenderer";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";

interface SlidePreviewProps {
  slides: Slide[];
  currentSlideIndex: number;
  onSlideEvent?: (event: SlideEvent) => boolean | void;
  onStopPlayback?: () => void;
  onClose?: () => void;
  isOpen: boolean;
  verticalIndex?: number;
  positioning?: "fixed" | "relative" | "absolute" | "sticky";
}

function SlidePreview({
  slides,
  currentSlideIndex,
  onSlideEvent,
  onStopPlayback,
  onClose,
  isOpen,
  verticalIndex = 0,
  positioning = "fixed",
}: SlidePreviewProps) {
  const { isPlaying } = useNextEditorMetadata();
  const collaboration = useOptionalCollaboration();
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
    collaboration?.stopFollowing("local-slide-input");
    onClose?.();
    onStopPlayback?.();
  };

  const handleMinimize = () => {
    collaboration?.stopFollowing("local-slide-input");
    emitSlideEvent("slide_minimize", currentSlide?.id, false);
    onStopPlayback?.();
  };

  // Handle messages from html slides that embed an iframe with the shared
  // interaction-capture script (see src/utils/iframeInteractionCapture.ts) —
  // unrelated to the slide renderer itself.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (isPlaying) return;

      // Only frames belonging to this page may drive recording state. Slide and
      // preview frames are sandboxed, so they post from an opaque ("null")
      // origin; everything legitimate is one of those or same-origin. Without
      // this, any page framing the app — the worker sets no frame-ancestors —
      // as well as window.opener and the untrusted runtime preview frame could
      // cancel follow-mode and forge interaction events into a live recording.
      if (event.origin !== "null" && event.origin !== window.location.origin) return;

      const { type, payload } = event.data || {};
      // payload was dereferenced unguarded, so a bare {type:"IFRAME_INTERACTION"}
      // threw a TypeError inside the listener.
      if (type === "IFRAME_INTERACTION" && payload && typeof payload === "object") {
        collaboration?.stopFollowing("local-slide-input");
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
  }, [collaboration, isPlaying, currentSlide?.id]);

  // Number of build steps on a slide (0 for html/markdown slides).
  const stepCountOf = (slide?: Slide): number =>
    slide?.contentType === "google-svg" ? (slide.steps?.length ?? 0) : 0;

  const isFirst = currentSlideIndex === 0 && verticalIndex === 0;
  const isLast =
    currentSlideIndex === slides.length - 1 && verticalIndex >= stepCountOf(currentSlide);

  const goToNextSlide = () => {
    if (isPlaying) return;
    collaboration?.stopFollowing("local-slide-input");

    // Reveal the next build step of the current slide before advancing.
    const currentStepCount = stepCountOf(currentSlide);
    if (currentStepCount > 0 && verticalIndex < currentStepCount) {
      const nextIndexv = verticalIndex + 1;
      emitSlideEvent("slide_change", currentSlide?.id, true, nextIndexv);
      return;
    }

    if (currentSlideIndex < slides.length - 1) {
      const newIndex = currentSlideIndex + 1;
      emitSlideEvent("slide_change", slides[newIndex]?.id, true, 0);
    }
  };

  const goToPrevSlide = () => {
    if (isPlaying) return;
    collaboration?.stopFollowing("local-slide-input");

    // Hide the last revealed build step of the current slide first.
    if (stepCountOf(currentSlide) > 0 && verticalIndex > 0) {
      const nextIndexv = verticalIndex - 1;
      emitSlideEvent("slide_change", currentSlide?.id, true, nextIndexv);
      return;
    }

    if (currentSlideIndex > 0) {
      const newIndex = currentSlideIndex - 1;
      // Standalone back-stepping lands fully revealed. A room-wide slide switch
      // always starts from the shared baseline build state.
      const prevIndexv = collaboration?.provider ? 0 : stepCountOf(slides[newIndex]);
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

  if (!isOpen) {
    return null;
  }

  if (!currentSlide) {
    const loading = Boolean(collaboration?.provider && collaboration.isTeachingLoading);
    return (
      <>
        <div className="fixed inset-0 z-90 bg-[#0b0d12]/90" onClick={handleClose} />
        <div className="fixed inset-1/2 z-100 flex aspect-video w-full max-w-7xl -translate-1/2 items-center justify-center rounded-2xl bg-slate-900 text-slate-300 shadow-2xl">
          <div className="flex flex-col items-center gap-3 text-sm" role="status">
            <p>{loading ? "Loading shared slide…" : "Shared slide unavailable"}</p>
            <div className="flex items-center gap-2">
              {!loading && collaboration?.provider && collaboration.canRetryAssets ? (
                <button
                  type="button"
                  onClick={() => collaboration.retryAssets()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
                >
                  <RefreshCw size={13} /> Retry
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleClose}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
              >
                <X size={13} /> Close
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const isNavigationEnabled = !isPlaying;

  return (
    <>
      <div
        className="fixed inset-0 z-90 bg-[#0b0d12]/90 opacity-0 animate-[fade-in_0.2s_ease-out_forwards] motion-reduce:animate-none motion-reduce:opacity-100"
        onClick={handleClose}
      />

      <div
        className={`${positioning} inset-1/2 -translate-1/2 z-100 bg-slate-900 rounded-2xl overflow-hidden flex flex-col shadow-2xl transition-shadow w-full max-w-7xl aspect-video`}
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

          <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
            <button
              type="button"
              onClick={handleMinimize}
              aria-label="Minimize slides"
              className="flex size-9 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60"
            >
              <Minimize2 className="size-4" />
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close slides"
              className="flex size-9 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60"
            >
              <X className="size-4" />
            </button>
          </div>

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

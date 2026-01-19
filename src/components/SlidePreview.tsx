import { useState, useCallback, useEffect } from 'react';
import {
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Monitor,
  Keyboard
} from 'lucide-react';
import type { Slide, SlideEvent } from '../types/slides';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import RevealSlideRenderer from './RevealSlideRenderer';

type SlidePreviewSize = 'small' | 'large';

interface SlidePreviewProps {
  slides: Slide[];
  currentSlideIndex: number;
  onSlideChange: (indexh: number, indexv?: number) => void;
  onSlideEvent?: (event: SlideEvent) => void;
  onStopPlayback?: () => void;
  isOpen: boolean;
  isMaximized?: boolean;
  verticalIndex?: number;
  currentInteraction?: import('../types/slides').IframeInteractionEvent;
  registerSlideNavigator?: (navigator: (indexh: number, indexv: number) => void) => void;
  positioning?: 'fixed' | 'relative' | 'absolute' | 'sticky';
}

export default function SlidePreview({
  slides,
  currentSlideIndex,
  onSlideChange,
  onSlideEvent,
  onStopPlayback,
  isOpen,
  isMaximized = false,
  verticalIndex = 0,
  currentInteraction,
  registerSlideNavigator,
  positioning = 'fixed'
}: SlidePreviewProps) {
  const { isPlaying } = useNextEditorContext();
  // Check record mode from sessionStorage
  const recordMode = sessionStorage.getItem('recordMode') === 'true';

  // Use isMaximized prop to determine size, but keep internal state for immediate updates
  const [size, setSize] = useState<SlidePreviewSize>(isMaximized ? 'large' : 'small');

  // Sync internal state with prop
  useEffect(() => {
    setSize(prev => {
      const next = isMaximized ? 'large' : 'small';
      if (prev === next) return prev;
      return next;
    });
  }, [isMaximized]);

  const currentSlide = slides[currentSlideIndex];

  const emitSlideEvent = useCallback((type: SlideEvent['type'], slideId?: string, isMaximizedState?: boolean, indexv?: number) => {
    onSlideEvent?.({
      type,
      timestamp: performance.now(),
      slideId,
      isMaximized: isMaximizedState,
      indexv
    });
  }, [onSlideEvent]);

  const getSizeClasses = () => {
    switch (size) {
      case 'small':
        return 'bottom-20 right-4 w-72 h-44 z-30';
      case 'large':
        return 'bottom-20 right-4 w-[1000px] max-w-[95vw] h-[700px] max-h-[85vh] z-[100]';
    }
  };

  const getSizeStyles = () => {
    if (size === 'large') {
      return {
        transform: 'translate(calc(-50vw + 50% + 1rem), calc(-50vh + 50% + 5rem))',
        transformOrigin: 'bottom right'
      };
    }

    return {
      transformOrigin: 'bottom right'
    };
  };

  const handleClick = () => {
    if (size === 'small') {
      setSize('large');
      emitSlideEvent('slide_maximize', currentSlide?.id, true);
      onStopPlayback?.();
    }
  };

  const handleMinimize = useCallback(() => {
    setSize('small');
    emitSlideEvent('slide_minimize', currentSlide?.id, false);
    onStopPlayback?.();
  }, [emitSlideEvent, currentSlide?.id, onStopPlayback]);

  const handleMaximize = () => {
    const isNowMaximized = size !== 'large';
    const newSize = isNowMaximized ? 'large' : 'small';
    setSize(newSize);
    emitSlideEvent(isNowMaximized ? 'slide_maximize' : 'slide_minimize', currentSlide?.id, isNowMaximized);
    onStopPlayback?.();
  };

  const handleSlideChangeFromReveal = useCallback((indexh: number, indexv?: number) => {
    if (isPlaying) return;
    onSlideChange(indexh, indexv);
    if (slides[indexh]) {
      emitSlideEvent('slide_change', slides[indexh].id, size === 'large', indexv);
    }
  }, [isPlaying, onSlideChange, slides, emitSlideEvent, size]);

  // Handle messages from the Reveal iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (isPlaying) return;

      const { type, payload } = event.data || {};
      if (type === 'IFRAME_INTERACTION') {
        const interaction = {
          type: payload.type,
          timestamp: performance.now(),
          target: payload.target,
          data: payload.data,
        };

        // Send the interaction event without stale position data
        onSlideEvent?.({
          type: 'slide_interaction',
          timestamp: performance.now(),
          slideId: currentSlide?.id,
          interaction
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isPlaying, currentSlide?.id, onSlideEvent]);

  const goToNextSlide = useCallback(() => {
    if (isPlaying) return;
    if (currentSlideIndex < slides.length - 1) {
      const newIndex = currentSlideIndex + 1;
      onSlideChange(newIndex); // Leave indexv undefined to use memory
      emitSlideEvent('slide_change', slides[newIndex]?.id, size === 'large');
    }
  }, [isPlaying, currentSlideIndex, slides, onSlideChange, emitSlideEvent, size]);

  const goToPrevSlide = useCallback(() => {
    if (isPlaying) return;
    if (currentSlideIndex > 0) {
      const newIndex = currentSlideIndex - 1;
      onSlideChange(newIndex); // Leave indexv undefined to use memory
      emitSlideEvent('slide_change', slides[newIndex]?.id, size === 'large');
    }
  }, [isPlaying, currentSlideIndex, onSlideChange, emitSlideEvent, slides, size]);

  // Keyboard navigation for large mode
  useEffect(() => {
    if (!isOpen || size !== 'large') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          goToPrevSlide();
          break;
        case 'ArrowRight':
          e.preventDefault();
          goToNextSlide();
          break;
        case 'Escape':
          e.preventDefault();
          handleMinimize();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, size, goToPrevSlide, goToNextSlide, handleMinimize]);

  if (!isOpen || !currentSlide) {
    return null;
  }

  return (
    <>
      {/* Backdrop for large size */}
      {size === 'large' && (
        <div
          className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm transition-all duration-500"
          onClick={handleMinimize}
        />
      )}

      <div
        className={`${positioning} bg-slate-900 rounded-2xl transition-all duration-500 ${getSizeClasses()} overflow-hidden border border-white/10`}
        style={{
          ...getSizeStyles()
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (size === 'small') handleClick();
        }}
      >
        {/* Header */}
        <div className="flex items-center bg-slate-800/80 backdrop-blur-md px-4 py-2 border-b border-white/5">
          {/* Window controls */}
          <div className="flex items-center gap-2 mr-4">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMinimize();
              }}
              className="w-3 h-3 rounded-full bg-amber-500 hover:bg-amber-400 transition-colors shadow-sm"
              title="Minimize"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMaximize();
              }}
              className="w-3 h-3 rounded-full bg-emerald-500 hover:bg-emerald-400 transition-colors shadow-sm"
              title={size === 'large' ? 'Shrink' : 'Maximize'}
            />
          </div>

          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
              <Monitor className="w-3 h-3 text-indigo-400" />
            </div>
            <span className="text-[11px] font-bold text-slate-300 tracking-tight uppercase">
              Slide {currentSlideIndex + 1} <span className="text-slate-500">of {slides.length}</span>
            </span>
          </div>

          {/* Navigation controls */}
          {size !== 'small' && (
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
                <ChevronLeft className="w-4 h-4" />
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
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {size === 'small' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMaximize();
              }}
              className="ml-auto p-1 text-slate-400 hover:text-white transition-all"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Slide content area */}
        <div
          className="relative w-full h-[calc(100%-40px)] bg-black"
          onClick={(e) => e.stopPropagation()}
        >
          <RevealSlideRenderer
            slides={slides}
            currentSlideIndex={currentSlideIndex}
            currentVerticalIndex={verticalIndex}
            currentInteraction={currentInteraction}
            onSlideChange={handleSlideChangeFromReveal}
            isNavigationEnabled={size !== 'small' && !isPlaying}
            registerSlideNavigator={registerSlideNavigator}
          />

          {/* Keyboard navigation hint */}
          {size === 'large' && recordMode && (
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 flex items-center gap-3 bg-slate-900/80 backdrop-blur-xl border border-white/10 px-4 py-2 rounded-2xl shadow-2xl opacity-0 hover:opacity-100 transition-opacity duration-500 pointer-events-none">
              <div className="p-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/20">
                <Keyboard className="w-4 h-4 text-indigo-400" />
              </div>
              <span className="text-xs font-bold text-slate-200">Use Arrow Keys to Navigate</span>
            </div>
          )}

          {/* Small mode overlay indicator */}
          {size === 'small' && (
            <div
              className="absolute inset-0 bg-indigo-600/0 cursor-pointer flex items-center justify-center group/overlay transition-all"
              onClick={(e) => {
                e.stopPropagation();
                handleClick();
              }}
            >
              <div className="bg-slate-900/90 backdrop-blur-md border border-white/10 p-2 rounded-xl scale-90 opacity-0 group-hover/overlay:opacity-100 group-hover/overlay:scale-100 transition-all duration-300 shadow-2xl">
                <Maximize2 className="w-4 h-4 text-indigo-400" />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
import { useState, useCallback, useEffect } from 'react';
import type { Slide, SlideEvent } from '../types/slides';
import { useScrimbaContext } from '../hooks/useScrimbaContext';

type SlidePreviewSize = 'small' | 'large';

interface SlidePreviewProps {
  slides: Slide[];
  currentSlideIndex: number;
  onSlideChange: (index: number) => void;
  onSlideEvent?: (event: SlideEvent) => void;
  onStopPlayback?: () => void;
  isOpen: boolean;
  isMaximized?: boolean;
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
  positioning = 'fixed'
}: SlidePreviewProps) {
  const { isPlaying } = useScrimbaContext();
  // Check record mode from sessionStorage (same pattern as CssCourse page)
  const recordMode = sessionStorage.getItem('recordMode') === 'true';
  
  // Use isMaximized prop to determine size, but keep internal state for immediate updates
  const [size, setSize] = useState<SlidePreviewSize>(isMaximized ? 'large' : 'small');
  
  // Sync internal state with prop
  useEffect(() => {
    setSize(isMaximized ? 'large' : 'small');
  }, [isMaximized]);
  
  const currentSlide = slides[currentSlideIndex];

  const emitSlideEvent = useCallback((type: SlideEvent['type'], slideId?: string, isMaximized?: boolean) => {
    onSlideEvent?.({
      type,
      timestamp: performance.now(),
      slideId,
      isMaximized
    });
  }, [onSlideEvent]);

  const getSizeClasses = () => {
    switch (size) {
      case 'small':
        return 'bottom-20 right-4 w-48 h-32';
      case 'large':
        return 'bottom-20 right-4 w-[800px] max-w-[90vw] h-[600px] max-h-[90vh]';
    }
  };

  const getSizeStyles = () => {
    if (size === 'large') {
      // Keep it positioned at bottom-right but use transform to center it
      // This way the positioning doesn't change, only the transform changes
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
      // Pause playback when maximizing through click
      onStopPlayback?.();
    }
  };

  const handleMinimize = useCallback(() => {
    setSize('small');
    emitSlideEvent('slide_minimize', currentSlide?.id, false);
    // Stop playback when minimizing
    onStopPlayback?.();
  }, [emitSlideEvent, currentSlide?.id, onStopPlayback]);

  const handleMaximize = () => {
    const newSize = size === 'large' ? 'small' : 'large';
    setSize(newSize);
    emitSlideEvent(newSize === 'large' ? 'slide_maximize' : 'slide_minimize', currentSlide?.id, newSize === 'large');
    // Pause playback on any size change (both maximize and minimize)
    onStopPlayback?.();
  };


  const goToNextSlide = useCallback(() => {
    if (isPlaying) return; // Disable navigation during playback
    if (currentSlideIndex < slides.length - 1) {
      const newIndex = currentSlideIndex + 1;
      onSlideChange(newIndex);
      emitSlideEvent('slide_change', slides[newIndex]?.id);
    }
  }, [isPlaying, currentSlideIndex, slides, onSlideChange, emitSlideEvent]);

  const goToPrevSlide = useCallback(() => {
    if (isPlaying) return; // Disable navigation during playback
    if (currentSlideIndex > 0) {
      const newIndex = currentSlideIndex - 1;
      onSlideChange(newIndex);
      emitSlideEvent('slide_change', slides[newIndex]?.id);
    }
  }, [isPlaying, currentSlideIndex, onSlideChange, emitSlideEvent, slides]);

  // Emit slide open event when component first opens
  useEffect(() => {
    if (isOpen && currentSlide) {
      emitSlideEvent('slide_open', currentSlide.id);
    }
  }, [isOpen, currentSlide, emitSlideEvent]);

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
      {/* Overlay for click-outside-to-minimize - only for large size */}
      {size === 'large' && (
        <div
          className="fixed inset-0 z-39"
          onClick={handleMinimize}
        />
      )}

      <div
        className={`${positioning} bg-white rounded shadow-lg z-40 transition-all duration-500 ease-in-out ${getSizeClasses()}`}
        style={{
          border: '1px solid #ccc',
          ...getSizeStyles()
        }}
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
      >
        {/* Browser-style header */}
        <div className="flex items-center bg-gray-100 px-3 py-2 rounded-t-lg border-b">
          {/* Window controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMinimize();
              }}
              className="w-3 h-3 rounded-full bg-yellow-400 hover:bg-yellow-500"
              title="Minimize"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMaximize();
              }}
              className="w-3 h-3 rounded-full bg-green-400 hover:bg-green-500"
              title={size === 'large' ? 'Minimize' : 'Maximize'}
            />
          </div>

          <span className="text-sm font-medium text-gray-700 ml-4">
            Slide {currentSlideIndex + 1} of {slides.length}
          </span>

          {/* Navigation controls */}
          {size !== 'small' && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goToPrevSlide();
                }}
                disabled={currentSlideIndex === 0 || isPlaying}
                className="text-gray-600 hover:text-gray-800 disabled:opacity-30 px-2 py-1"
                title="Previous slide"
              >
                ‹
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goToNextSlide();
                }}
                disabled={currentSlideIndex === slides.length - 1 || isPlaying}
                className="text-gray-600 hover:text-gray-800 disabled:opacity-30 px-2 py-1"
                title="Next slide"
              >
                ›
              </button>
            </div>
          )}
        </div>

        {/* Slide content */}
        <div className="relative w-full border-0 rounded-b-lg overflow-hidden" style={{ height: 'calc(100% - 48px)' }}>
          <img
            src={currentSlide.imageUrl}
            alt={`Slide ${currentSlideIndex + 1}`}
            className="w-full h-full object-contain bg-gray-50"
            style={{ imageRendering: 'crisp-edges' }}
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.style.display = 'none';
              target.parentElement!.innerHTML = `
                <div class="w-full h-full flex items-center justify-center bg-gray-100">
                  <div class="text-center text-gray-500">
                    <div class="text-2xl mb-2">⚠️</div>
                    <div class="text-sm">Failed to load image</div>
                    <div class="text-xs mt-1 break-all px-4">${currentSlide.imageUrl}</div>
                  </div>
                </div>
              `;
            }}
          />
          
          {/* Keyboard navigation hint for large size - only show when not in record mode */}
          {size === 'large' && recordMode && (
            <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 text-white px-3 py-1 rounded text-sm">
              Use ← → keys to navigate
            </div>
          )}
        </div>
      </div>
    </>
  );
}
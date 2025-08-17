import { useState, useCallback } from 'react';
import type { Slide } from '../types/slides';

interface SlidesManagerProps {
  slides: Slide[];
  onSlidesChange: (slides: Slide[]) => void;
  onStartPresentation?: () => void;
  onClose?: () => void;
}

export default function SlidesManager({ slides, onSlidesChange, onStartPresentation, onClose }: SlidesManagerProps) {
  const [newSlideUrl, setNewSlideUrl] = useState('');

  const addSlide = useCallback(() => {
    if (!newSlideUrl.trim()) return;

    const newSlide: Slide = {
      id: Date.now().toString(),
      imageUrl: newSlideUrl.trim(),
      order: slides.length,
    };

    onSlidesChange([...slides, newSlide]);
    setNewSlideUrl('');
  }, [newSlideUrl, slides, onSlidesChange]);

  const removeSlide = useCallback((slideId: string) => {
    const updatedSlides = slides
      .filter(slide => slide.id !== slideId)
      .map((slide, index) => ({ ...slide, order: index }));
    onSlidesChange(updatedSlides);
  }, [slides, onSlidesChange]);

  const moveSlide = useCallback((slideId: string, direction: 'up' | 'down') => {
    const slideIndex = slides.findIndex(slide => slide.id === slideId);
    if (slideIndex === -1) return;

    const newIndex = direction === 'up' ? slideIndex - 1 : slideIndex + 1;
    if (newIndex < 0 || newIndex >= slides.length) return;

    const updatedSlides = [...slides];
    [updatedSlides[slideIndex], updatedSlides[newIndex]] = [updatedSlides[newIndex], updatedSlides[slideIndex]];
    
    // Update order numbers
    updatedSlides.forEach((slide, index) => {
      slide.order = index;
    });

    onSlidesChange(updatedSlides);
  }, [slides, onSlidesChange]);

  return (
    <div className="bg-white rounded-lg shadow-lg p-4 max-w-md">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-800">Presentation Slides</h3>
        <div className="flex items-center gap-2">
          {slides.length > 0 && (
            <button
              onClick={onStartPresentation}
              className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-sm"
            >
              Ready
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              title="Close"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Add new slide */}
      <div className="mb-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={newSlideUrl}
            onChange={(e) => setNewSlideUrl(e.target.value)}
            placeholder="Image URL (absolute/full path)"
            className="min-w-3xs flex-1 px-3 py-2 border border-gray-300 rounded text-sm text-gray-900 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            onKeyDown={(e) => e.key === 'Enter' && addSlide()}
          />
          <button
            onClick={addSlide}
            className="bg-green-500 hover:bg-green-600 text-white px-3 py-2 rounded text-sm"
          >
            Add
          </button>
        </div>
      </div>

      {/* Slides list */}
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {slides.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">
            No slides added yet.<br />Add an image URL to get started.
          </p>
        ) : (
          slides.map((slide, index) => (
            <div
              key={slide.id}
              className="flex items-center gap-3 p-2 border border-gray-200 rounded hover:bg-gray-50"
            >
              {/* Slide preview */}
              <div className="w-12 h-8 bg-gray-200 rounded overflow-hidden flex-shrink-0">
                <img
                  src={slide.imageUrl}
                  alt={`Slide ${index + 1}`}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.style.display = 'none';
                  }}
                />
              </div>

              {/* Slide info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800">
                  Slide {index + 1}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {slide.imageUrl}
                </p>
              </div>

              {/* Controls */}
              <div className="flex gap-1">
                <button
                  onClick={() => moveSlide(slide.id, 'up')}
                  disabled={index === 0}
                  className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  onClick={() => moveSlide(slide.id, 'down')}
                  disabled={index === slides.length - 1}
                  className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  onClick={() => removeSlide(slide.id)}
                  className="p-1 text-red-400 hover:text-red-600"
                  title="Remove slide"
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
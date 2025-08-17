import { useState } from 'react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';
import { useSlidesContext } from '../contexts/SlidesContext';
import SlidesManager from './SlidesManager';

export default function SlidesButton() {
  const { isRecording } = useScrimbaContext();
  const [showManager, setShowManager] = useState(false);
  
  const {
    slides,
    setSlides,
    startPresentation,
  } = useSlidesContext();

  return (
    <div className="relative">
      <button
        onClick={() => setShowManager(!showManager)}
        className="px-3 py-1 text-xs text-gray-300 hover:text-white bg-gray-600 hover:bg-gray-500 rounded transition-colors"
        title="Manage presentation slides"
      >
        📊 Slides {slides.length > 0 && `(${slides.length})`}
      </button>

      {/* Recording indicator for slides */}
      {isRecording && slides.length > 0 && showManager && (
        <div className="fixed top-16 left-4 z-50 bg-red-500 text-white px-2 py-1 rounded text-xs animate-pulse">
          Recording slides events
        </div>
      )}

      {/* Slides Manager Dropdown */}
      {showManager && (
        <div className="absolute top-full right-0 mt-2 z-50">
          <SlidesManager
            slides={slides}
            onSlidesChange={setSlides}
            onStartPresentation={() => {
              startPresentation();
              setShowManager(false);
            }}
            onClose={() => setShowManager(false)}
          />
        </div>
      )}
    </div>
  );
}
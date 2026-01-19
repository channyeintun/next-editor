import { useState } from 'react';
import { Presentation, Circle } from 'lucide-react';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import { useSlidesContext } from '../contexts/SlidesContext';
import SlidesManager from './SlidesManager';

export default function SlidesButton() {
  const { isRecording } = useNextEditorContext();
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
        className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-300 border shadow-sm ${showManager
          ? 'bg-indigo-600 border-indigo-500 text-white shadow-md'
          : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:border-slate-600'
          }`}
        title="Manage presentation slides"
      >
        <Presentation className={`w-4 h-4 transition-transform duration-300 ${showManager ? 'scale-110' : ''}`} />
        <span className="tracking-tight">Slides</span>
        {slides.length > 0 && (
          <span className={`flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-md text-[10px] font-black ${showManager ? 'bg-white text-indigo-600' : 'bg-slate-700 text-slate-300'
            }`}>
            {slides.length}
          </span>
        )}
      </button>

      {/* Recording indicator for slides */}
      {isRecording && slides.length > 0 && (
        <div className="absolute -top-1 -right-1 flex">
          <Circle className="w-2.5 h-2.5 fill-rose-500 text-rose-500 animate-pulse" />
        </div>
      )}

      {/* Slides Manager Dropdown */}
      {showManager && (
        <>
          {/* Backdrop for mobile/click away */}
          <div
            className="fixed inset-0 z-[49] bg-black/5"
            onClick={() => setShowManager(false)}
          />
          <div className="fixed inset-x-4 top-16 z-[50] sm:absolute sm:inset-auto sm:top-full sm:right-0 sm:mt-3 sm:w-auto animate-in fade-in slide-in-from-top-2 duration-300 ease-out origin-top sm:origin-top-right">
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
        </>
      )}
    </div>
  );
}
import { useEffect, useState } from 'react';
import { Presentation, Circle } from 'lucide-react';
import { useNextEditorActions, useNextEditorMetadata } from '../hooks/useNextEditorContext';
import { useSlidesContext } from '../contexts/SlidesContext';
import SlidesManager from './SlidesManager';

export default function SlidesButton() {
  const { pause } = useNextEditorActions();
  const { isRecording, isPlaying, usesPlaybackModel } = useNextEditorMetadata();
  const [showManager, setShowManager] = useState(false);

  const {
    slides,
    previewState,
    setSlides,
    openPresentation,
    startPresentation,
    closePresentation,
  } = useSlidesContext();

  const hasSlides = slides.length > 0;
  // In recording/playback/presentation states, this button should only act as a slide visibility toggle.
  const showPresentationToggle = usesPlaybackModel || isRecording || previewState.isOpen;
  const isPresentationVisible = previewState.isOpen && previewState.isMaximized === true;

  useEffect(() => {
    if (showPresentationToggle) {
      setShowManager(false);
    }
  }, [showPresentationToggle]);

  const handlePresentationToggle = () => {
    if (!hasSlides) {
      return;
    }

    if (isPlaying) {
      pause();
    }

    if (isPresentationVisible) {
      closePresentation();
      return;
    }

    openPresentation();
  };

  return (
    <div className="relative">
      <button
        onClick={() => {
          if (showPresentationToggle) {
            handlePresentationToggle();
            return;
          }

          setShowManager(!showManager);
        }}
        disabled={showPresentationToggle && !hasSlides}
        aria-pressed={showPresentationToggle ? isPresentationVisible : showManager}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold rounded-lg transition-all duration-300 border shadow-sm ${showPresentationToggle
          ? isPresentationVisible
            ? 'bg-indigo-600 border-indigo-500 text-white shadow-md'
            : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:border-slate-600'
          : showManager
          ? 'bg-indigo-600 border-indigo-500 text-white shadow-md'
          : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:border-slate-600'
          } ${showPresentationToggle && !hasSlides ? 'cursor-not-allowed opacity-50' : ''}`}
        title={showPresentationToggle ? (isPresentationVisible ? 'Hide slides' : 'Show slides') : 'Manage presentation slides'}
      >
        <Presentation className={`transition-transform duration-300 size-4 ${(showManager || isPresentationVisible) ? 'scale-110' : ''}`} />
        {hasSlides && (
          <span className={`flex items-center justify-center min-w-4.5 h-4.5 px-1 rounded-md text-[10px] font-black ${showManager ? 'bg-white text-indigo-600' : 'bg-slate-700 text-slate-300'
            }`}>
            {slides.length}
          </span>
        )}
      </button>

      {/* Recording indicator for slides */}
      {isRecording && slides.length > 0 && (
        <div className="absolute -top-1 -right-1 flex">
          <Circle className="fill-rose-500 text-rose-500 animate-pulse size-2.5" />
        </div>
      )}

      {/* Slides Manager Dropdown */}
      {showManager && !showPresentationToggle && (
        <>
          {/* Backdrop for mobile/click away */}
          <div
            className="fixed inset-0 z-49 bg-black/5"
            onClick={() => setShowManager(false)}
          />
          <div className="fixed inset-x-4 top-20 z-50 sm:absolute sm:inset-auto sm:top-full sm:right-0 sm:mt-3 sm:w-auto animate-in fade-in slide-in-from-top-2 duration-300 ease-out origin-top sm:origin-top-right">
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
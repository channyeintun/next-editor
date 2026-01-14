import { Routes, Route } from 'react-router-dom';
import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import DragDropOverlay from './components/DragDropOverlay';
import Preview from './components/Preview.tsx';
import MastodonIcon from './components/icon/Mastodon';
import ScrimbaImageSaveModal from './components/ScrimbaImageSaveModal';
import { useState } from 'react';
import SlidePanel from './components/SlidePanel';
import { ScrimbaProvider } from './contexts/ScrimbaProvider';
import { SlidesProvider } from './contexts/SlidesContext';
import { useDragAndDropUrl } from './hooks/useDragAndDropUrl';
import { useUrlQuery } from './hooks/useUrlQuery';
import { useScrimbaContext } from './hooks/useScrimbaContext';
import SlidesButton from './components/SlidesButton';
import CssCourse from './pages/CssCourse';
import './App.css'
import CursorComponent from './components/Cursor.tsx';

function App() {
  return (
    <ScrimbaProvider>
      <SlidesProvider>
        <Routes>
          <Route path="/" element={<AppContent />} />
          <Route path="/css-course" element={<CssCourse />} />
        </Routes>
      </SlidesProvider>
    </ScrimbaProvider>
  );
}

function AppContent() {
  const { isDragging, isLoading: dragLoading } = useDragAndDropUrl();
  const { isLoading: urlLoading } = useUrlQuery();
  const {
    currentRecording,
    importFromFile,
    loadRecording,
  } = useScrimbaContext();

  const [showImageSaveModal, setShowImageSaveModal] = useState(false);
  const isLoading = dragLoading || urlLoading;

  const handleImport = async () => {
    try {
      const importedRecordings = await importFromFile();
      if (importedRecordings.length > 0) {
        loadRecording(importedRecordings[0]);
      }
    } catch (error) {
      console.error('Import failed:', error);
    }
  };

  const handleExport = () => {
    if (currentRecording) {
      setShowImageSaveModal(true);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden">
      {/* Editor Main Toolbar (besides import export buttons) */}
      <div className="bg-gray-700 px-4 py-1.5 flex items-center justify-between border-b border-gray-600">
        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Editor</span>
        <div className="flex items-center gap-2">
          {currentRecording && (
            <button
              onClick={() => setShowImageSaveModal(true)}
              className="p-1.5 text-white bg-indigo-600 hover:bg-indigo-500 rounded transition-colors flex items-center justify-center shadow-sm"
              title="Share on Mastodon"
            >
              <MastodonIcon />
            </button>
          )}

          <button
            onClick={handleImport}
            className="px-3 py-1 text-xs text-gray-300 hover:text-white bg-gray-600 hover:bg-gray-500 rounded transition-colors"
          >
            Import
          </button>
          <button
            onClick={handleExport}
            disabled={!currentRecording}
            className="px-3 py-1 text-xs text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors shadow-sm font-medium"
          >
            Save as Image
          </button>

          <div className="w-[1px] h-4 bg-gray-600 mx-1" />
          <SlidesButton />
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative">
        <CodeEditor />
        <CursorComponent />
        <Preview />
        <SlidePanel />
      </div>

      <MediaControls />

      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />

      {currentRecording && (
        <ScrimbaImageSaveModal
          recording={currentRecording}
          isVisible={showImageSaveModal}
          onSave={() => setShowImageSaveModal(false)}
          onCancel={() => setShowImageSaveModal(false)}
        />
      )}
    </div>
  );
}

export default App;
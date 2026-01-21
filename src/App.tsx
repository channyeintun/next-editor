import { Routes, Route } from 'react-router-dom';
import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import DragDropOverlay from './components/DragDropOverlay';
import Preview from './components/Preview.tsx';
import SlidePanel from './components/SlidePanel';
import FloatingPlayButton from './components/FloatingPlayButton';
import { NextEditorProvider } from './contexts/NextEditorProvider.tsx';
import { SlidesProvider } from './contexts/SlidesContext';
import { useDragAndDropUrl } from './hooks/useDragAndDropUrl';
import { useUrlQuery } from './hooks/useUrlQuery';
import CursorComponent from './components/Cursor.tsx';
import LandingPage from './components/LandingPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/code" element={<AppContent />} />
    </Routes>
  );
}

function AppContent() {
  return (
    <NextEditorProvider>
      <SlidesProvider>
        <EditorLayout />
      </SlidesProvider>
    </NextEditorProvider>
  );
}

function EditorLayout() {
  const { isDragging, isLoading: dragLoading } = useDragAndDropUrl();
  const { isLoading: urlLoading } = useUrlQuery();

  const isLoading = dragLoading || urlLoading;

  // Check URL for showImportExport parameter (defaults to true if not specified)
  const urlParams = new URLSearchParams(window.location.search);
  const readOnly = urlParams.get('readOnly') === 'true';

  return (
    <div className="h-[100dvh] flex flex-col bg-slate-950 text-white overflow-hidden">
      <div className="flex-1 relative overflow-hidden">
        <CodeEditor showImportExport={!readOnly} />
        <CursorComponent />
        <Preview />
        <SlidePanel />
      </div>

      <MediaControls recordMode={!readOnly} />

      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />

      <FloatingPlayButton />
    </div>
  );
}

export default App;
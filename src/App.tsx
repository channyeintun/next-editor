import { Routes, Route } from 'react-router-dom';
import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import DragDropOverlay from './components/DragDropOverlay';
import Preview from './components/Preview.tsx';
import SlidePanel from './components/SlidePanel';
import { ScrimbaProvider } from './contexts/ScrimbaProvider';
import { SlidesProvider } from './contexts/SlidesContext';
import { useDragAndDropUrl } from './hooks/useDragAndDropUrl';
import { useUrlQuery } from './hooks/useUrlQuery';
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

  const isLoading = dragLoading || urlLoading;

  // Check URL for showImportExport parameter (defaults to true if not specified)
  const urlParams = new URLSearchParams(window.location.search);
  const showImportExport = urlParams.get('showImportExport') !== 'false';

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden">
      <div className="flex-1 overflow-hidden relative">
        <CodeEditor showImportExport={showImportExport} />
        <CursorComponent />
        <Preview />
        <SlidePanel />
      </div>

      <MediaControls />

      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />
    </div>
  );
}

export default App;
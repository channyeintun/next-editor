import { Routes, Route } from 'react-router-dom';
import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import DragDropOverlay from './components/DragDropOverlay';
import Preview from './components/Preview.tsx';
import { ScrimbaProvider } from './contexts/ScrimbaContext.tsx';
import { useDragAndDropUrl } from './hooks/useDragAndDropUrl';
import { useUrlQuery } from './hooks/useUrlQuery';
import CssCourse from './pages/CssCourse';
import './App.css'
import CursorComponent from './components/Cursor.tsx';

function App() {
  return (
    <ScrimbaProvider>
      <Routes>
        <Route path="/" element={<AppContent />} />
        <Route path="/css-course" element={<CssCourse />} />
      </Routes>
    </ScrimbaProvider>
  );
}

function AppContent() {
  const { isDragging, isLoading: dragLoading } = useDragAndDropUrl();
  const { isLoading: urlLoading } = useUrlQuery();
  const isLoading = dragLoading || urlLoading;

  return (
    <div className="h-screen bg-gray-900 text-white">
      <div className="bg-gray-800">
        <CodeEditor />
      </div>
      
      <MediaControls />
      <CursorComponent />
      <Preview />
      
      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />
    </div>
  );
}

export default App;
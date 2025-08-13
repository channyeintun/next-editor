import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import AudioPlayer from './components/AudioPlayer';
import DragDropOverlay from './components/DragDropOverlay';
import Preview from './components/Preview.tsx';
import { ScrimbaProvider } from './contexts/ScrimbaContext.tsx';
import { useDragAndDropUrl } from './hooks/useDragAndDropUrl';
import { useUrlQuery } from './hooks/useUrlQuery';
import './App.css'
import CursorComponent from './components/Cursor.tsx';

function App() {
  return (
    <ScrimbaProvider>
      <AppContent />
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
      <AudioPlayer />
      <CursorComponent />
      <Preview />
      
      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />
    </div>
  );
}

export default App;
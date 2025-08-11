import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import AudioPlayer from './components/AudioPlayer';
import DragDropOverlay from './components/DragDropOverlay';
import { ScrimbaProvider } from './contexts/ScrimbaContext.tsx';
import { useDragAndDropUrl } from './hooks/useDragAndDropUrl';
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
  const { isDragging, isLoading } = useDragAndDropUrl();

  return (
    <div className="h-screen bg-gray-900 text-white">
      <div className="bg-gray-800">
        <CodeEditor />
      </div>
      
      <MediaControls />
      <AudioPlayer />
      <CursorComponent />
      
      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />
    </div>
  );
}

export default App;
import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import AudioPlayer from './components/AudioPlayer';
import { ScrimbaProvider } from './contexts/ScrimbaContext.tsx';
import './App.css'
import CursorComponent from './components/Cursor.tsx';

function App() {
  return (
    <ScrimbaProvider>
      <div className="h-screen bg-gray-900 text-white">
        <div className="bg-gray-800">
          <CodeEditor />
        </div>
        
        <MediaControls />
        <AudioPlayer />
        <CursorComponent />
      </div>
    </ScrimbaProvider>
  );
}

export default App;
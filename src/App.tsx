import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import AudioPlayer from './components/AudioPlayer';
import { ScrimbaProvider } from './contexts/ScrimbaContext.tsx';
import './App.css'

function App() {
  return (
    <ScrimbaProvider>
      <div className="h-screen bg-gray-900 text-white flex flex-col">
        <div className="flex-1">
          <div className="bg-gray-800 h-full flex flex-col">
            <CodeEditor />
          </div>
        </div>
        
        {/* Bottom Media Controls */}
        <MediaControls />
        
        {/* Audio Player - handles audio sync */}
        <AudioPlayer />
      </div>
    </ScrimbaProvider>
  );
}

export default App;
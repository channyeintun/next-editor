import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import RecordingsList from './components/RecordingsList';
import AudioPlayer from './components/AudioPlayer';
import { ScrimbaProvider } from './contexts/ScrimbaContext.tsx';
import './App.css'

function App() {
  return (
    <ScrimbaProvider>
      <div className="min-h-screen bg-gray-900 text-white">
        <div className="container mx-auto px-4 py-6">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-blue-400 mb-2">
              🎬 Interactive Coding Platform
            </h1>
            <p className="text-gray-400 text-lg">
              Record and replay your coding sessions with useScrimba
            </p>
          </div>

          <div className="grid lg:grid-cols-3 gap-6">
            {/* Main Editor Area */}
            <div className="lg:col-span-2">
              <div className="bg-gray-800 rounded-lg overflow-hidden shadow-xl">
                <div className="bg-gray-700 px-4 py-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">Code Editor</span>
                  <div className="flex items-center space-x-2">
                    <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                    <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
                    <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                  </div>
                </div>
                <CodeEditor height="600px" />
              </div>
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Media Controls */}
              <MediaControls />
              
              {/* Recordings List */}
              <RecordingsList />
            </div>
          </div>
        </div>
        
        {/* Audio Player - handles audio sync */}
        <AudioPlayer />
      </div>
    </ScrimbaProvider>
  );
}

export default App;
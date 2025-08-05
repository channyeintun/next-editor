import { useEffect } from 'react';
import { Provider } from 'react-redux';
import { store } from './store';
import CodeEditor from './components/CodeEditor';
import MediaControls from './components/MediaControls';
import RecordingsList from './components/RecordingsList';
import AudioPlayer from './components/AudioPlayer';
import { useAudioRecording } from './hooks/useAudioRecording';
import { useReplaySync } from './hooks/useReplaySync';
import { recordingService } from './services/RecordingService';
import { useSelector } from 'react-redux';
import type { RootState } from './store';
import './App.css'

function AppContent() {
  const audioRecording = useAudioRecording();
  const { currentRecording, isPlaying, currentTime, playbackSpeed, hasEnded } = useSelector((state: RootState) => state.replay);
  
  // Sync replay events with time
  useReplaySync();

  useEffect(() => {
    recordingService.setAudioRecordingHook(audioRecording);
  }, [audioRecording]);

  const handleStartRecording = async () => {
    const success = await recordingService.startSession();
    if (!success) {
      alert('Failed to start recording. Please check your microphone permissions.');
    }
  };

  const handleStopRecording = async () => {
    const recording = await recordingService.stopSession();
    if (recording) {
      console.log('Recording saved:', recording);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-gray-800 p-5 text-center border-b border-gray-600">
        <h1 className="text-4xl font-bold text-blue-500 mb-2">Interactive Coding Platform</h1>
        <p className="text-gray-300 text-lg">Record and replay coding sessions like Scrimba</p>
      </header>

      <main className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-5 p-5 min-h-[calc(100vh-120px)]">
        <div className="flex flex-col gap-5">
          <div className="border border-gray-600 rounded-lg overflow-hidden">
            <CodeEditor 
              language="javascript"
              theme="vs-dark"
              height="500px"
            />
          </div>
          
          <MediaControls
            onRecord={handleStartRecording}
            onStopRecording={handleStopRecording}
          />
        </div>

        <div className="bg-gray-800 rounded-lg p-5 max-h-[calc(100vh-160px)] xl:max-h-[calc(100vh-160px)] md:max-h-96 overflow-y-auto">
          <RecordingsList />
        </div>

        {currentRecording?.audioBlob && (
          <AudioPlayer
            audioBlob={currentRecording.audioBlob}
            isPlaying={isPlaying}
            currentTime={currentTime}
            playbackSpeed={playbackSpeed}
            hasEnded={hasEnded}
          />
        )}
      </main>

      {audioRecording.error && (
        <div className="fixed top-5 right-5 bg-red-600 text-white p-4 rounded-lg shadow-lg z-50 max-w-sm">
          Error: {audioRecording.error}
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <Provider store={store}>
      <AppContent />
    </Provider>
  );
}

export default App

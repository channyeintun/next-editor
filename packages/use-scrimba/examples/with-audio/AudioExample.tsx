import React, { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useScrimba } from 'use-scrimba';

/**
 * Example with audio recording integration
 */
export const AudioExample: React.FC = () => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const scrimbaHook = useScrimba({
    editorRef,
    audioRef, // NEW: Enable native audio synchronization
    onRecordingStart: async () => {
      console.log('📹 Recording started with perfect audio sync');
      // Start audio recording when editor recording starts
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        
        // Reset audio chunks
        audioChunksRef.current = [];
        
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };
        
        mediaRecorder.onstop = () => {
          // Stop all tracks to release microphone
          stream.getTracks().forEach(track => track.stop());
        };
        
        mediaRecorder.start();
        setIsRecordingAudio(true);
        
      } catch (error) {
        console.error('Failed to start audio recording:', error);
      }
    },
    onRecordingStop: () => {
      console.log('⏹️ Recording stopped');
      // Stop audio recording when editor recording stops
      if (mediaRecorderRef.current && isRecordingAudio) {
        mediaRecorderRef.current.stop();
        setIsRecordingAudio(false);
      }
    },
    onPlaybackStart: () => console.log('▶️ Perfect synchronized playback started'),
    onPlaybackPause: () => console.log('⏸️ Synchronized playback paused'),
  });

  // Destructure with explicit typing
  const {
    isRecording,
    isPlaying,
    currentRecording,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    handleEditorChange,
  } = scrimbaHook;

  // Custom stop recording with audio
  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecordingAudio) {
      mediaRecorderRef.current.onstop = () => {
        // Create audio blob and attach to recording
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stopRecording({ audioBlob });
      };
      mediaRecorderRef.current.stop();
      setIsRecordingAudio(false);
    } else {
      stopRecording();
    }
  };

  // Audio playback is now handled automatically by the hook via audioRef
  // No manual audio playback needed - perfect synchronization guaranteed!

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>🎤 useScrimba with Audio Recording</h1>
      
      <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f0f8ff', borderRadius: '8px' }}>
        <h3>📝 Instructions</h3>
        <ol>
          <li>Click "Start Recording" - this will request microphone permission</li>
          <li>Code in the editor while speaking</li>
          <li>Click "Stop Recording" to save both code and audio</li>
          <li>Use "Play" to replay with PERFECT audio/code synchronization!</li>
        </ol>
      </div>
      
      {/* Recording Status */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ 
          padding: '10px', 
          backgroundColor: isRecording ? '#ffe6e6' : '#e6ffe6', 
          borderRadius: '4px',
          display: 'inline-block'
        }}>
          {isRecording ? (
            <span>🔴 Recording: Code + Audio</span>
          ) : (
            <span>⚫ Not Recording</span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div style={{ marginBottom: '20px' }}>
        <button 
          onClick={startRecording} 
          disabled={isRecording}
          style={{ 
            marginRight: '10px', 
            padding: '10px 20px',
            backgroundColor: isRecording ? '#ccc' : '#4CAF50',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}
        >
          {isRecording ? '🔴 Recording...' : '🎬 Start Recording'}
        </button>
        
        <button 
          onClick={handleStopRecording} 
          disabled={!isRecording}
          style={{ 
            marginRight: '10px', 
            padding: '10px 20px',
            backgroundColor: !isRecording ? '#ccc' : '#f44336',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}
        >
          ⏹️ Stop Recording
        </button>

        <button 
          onClick={play} 
          disabled={!currentRecording || isPlaying}
          style={{ 
            marginRight: '10px', 
            padding: '10px 20px',
            backgroundColor: (!currentRecording || isPlaying) ? '#ccc' : '#2196F3',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}
        >
          ▶️ Play Session
        </button>

        <button 
          onClick={pause} 
          disabled={!isPlaying}
          style={{ 
            marginRight: '10px', 
            padding: '10px 20px',
            backgroundColor: !isPlaying ? '#ccc' : '#ff9800',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}
        >
          ⏸️ Pause
        </button>

        <button 
          onClick={stop} 
          disabled={!currentRecording}
          style={{ 
            marginRight: '10px', 
            padding: '10px 20px',
            backgroundColor: !currentRecording ? '#ccc' : '#9C27B0',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}
        >
          ⏹️ Stop
        </button>

        {/* Audio is automatically synchronized during playback - no separate audio button needed! */}
      </div>

      {/* Audio Info */}
      {(currentRecording as { audioBlob?: Blob })?.audioBlob && (
        <div style={{ 
          marginBottom: '20px', 
          padding: '15px', 
          backgroundColor: '#e8f5e8', 
          borderRadius: '8px',
          border: '1px solid #4caf50'
        }}>
          <h3>🎵 Perfect Audio Synchronization Available!</h3>
          <p>This recording includes audio narration that will play in perfect sync with code changes.</p>
          <p>Audio size: {((currentRecording as { audioBlob?: Blob })?.audioBlob?.size ?? 0) / 1024} KB</p>
          <p><strong>✨ Master Timeline Architecture ensures zero-drift synchronization!</strong></p>
        </div>
      )}

      {/* Hidden Audio Element - Managed by useScrimba hook for perfect sync */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* Editor */}
      <div style={{ marginBottom: '20px' }}>
        <h2>Code Editor</h2>
        <Editor
          height="400px"
          language="javascript"
          theme="vs-dark"
          defaultValue={`// 🎤 Audio + Code Recording Example
// Speak while you code - your voice will be recorded!

function createTutorial() {
  const steps = [
    'Explain the concept',
    'Write the code',
    'Test it works',
    'Refactor if needed'
  ];
  
  return steps.map((step, index) => {
    console.log(\`Step \${index + 1}: \${step}\`);
    return step;
  });
}

// Try explaining this code while typing
const tutorial = createTutorial();`}
          onMount={(editor) => { 
            editorRef.current = editor; 
          }}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            automaticLayout: true,
          }}
        />
      </div>

      {/* Tips */}
      <div style={{ 
        padding: '15px', 
        backgroundColor: '#e8f5e8', 
        borderRadius: '8px',
        border: '1px solid #4caf50'
      }}>
        <h3>💡 Tips for Perfect Audio Recording</h3>
        <ul>
          <li>Make sure your microphone is working before starting</li>
          <li>Speak clearly while coding to create great tutorials</li>
          <li>The audio is stored with the recording and synced perfectly during playback</li>
          <li><strong>NEW: Audio and code are synchronized with millisecond precision!</strong></li>
          <li><strong>🎯 Independent master timeline eliminates all sync drift</strong></li>
        </ul>
      </div>
    </div>
  );
};
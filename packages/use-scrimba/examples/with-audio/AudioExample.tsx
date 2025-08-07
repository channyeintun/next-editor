import React, { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useScrimba } from 'use-scrimba';

/**
 * Example with audio recording integration
 */
export const AudioExample: React.FC = () => {
  const editorRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const scrimbaHook = useScrimba({
    editorRef,
    onRecordingStart: async () => {
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
      // Stop audio recording when editor recording stops
      if (mediaRecorderRef.current && isRecordingAudio) {
        mediaRecorderRef.current.stop();
        setIsRecordingAudio(false);
      }
    },
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
    handleEditorMount,
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

  const playAudio = () => {
    if (currentRecording && 'audioBlob' in currentRecording && currentRecording.audioBlob) {
      const audio = new Audio(URL.createObjectURL(currentRecording.audioBlob));
      audio.play();
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>🎤 useScrimba with Audio Recording</h1>
      
      <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f0f8ff', borderRadius: '8px' }}>
        <h3>📝 Instructions</h3>
        <ol>
          <li>Click "Start Recording" - this will request microphone permission</li>
          <li>Code in the editor while speaking</li>
          <li>Click "Stop Recording" to save both code and audio</li>
          <li>Use "Play" to replay the coding session (audio separate for now)</li>
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

        {currentRecording && 'audioBlob' in currentRecording && currentRecording.audioBlob && (
          <button 
            onClick={playAudio}
            style={{ 
              padding: '10px 20px',
              backgroundColor: '#FF5722',
              color: 'white',
              border: 'none',
              borderRadius: '4px'
            }}
          >
            🔊 Play Audio
          </button>
        )}
      </div>

      {/* Audio Info */}
      {currentRecording && 'audioBlob' in currentRecording && currentRecording.audioBlob && (
        <div style={{ 
          marginBottom: '20px', 
          padding: '15px', 
          backgroundColor: '#fff3e0', 
          borderRadius: '8px',
          border: '1px solid #ffcc02'
        }}>
          <h3>🎵 Audio Available</h3>
          <p>This recording includes audio narration. Audio size: {currentRecording && (currentRecording as any).audioBlob ? ((currentRecording as any).audioBlob.size / 1024).toFixed(1) : '0'} KB</p>
        </div>
      )}

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
            handleEditorMount(editor as any); 
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
        <h3>💡 Tips for Audio Recording</h3>
        <ul>
          <li>Make sure your microphone is working before starting</li>
          <li>Speak clearly while coding to create great tutorials</li>
          <li>The audio is stored with the recording for playback</li>
          <li>Future versions will sync audio with code playback automatically</li>
        </ul>
      </div>
    </div>
  );
};
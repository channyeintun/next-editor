# use-scrimba

A powerful React hook for recording and replaying Monaco Editor interactions with Scrimba-like functionality.

## Demo

🎬 **[Live Demo](https://use-scrimba.vercel.app/)** - See use-scrimba in action with recording and playback features!

## Features

🎥 **Record Editor Interactions** - Capture every keystroke, text cursor movement, selection, scroll event, and mouse cursor movements with precise timestamps

🎬 **Perfect Audio Sync** - Millisecond-precise audio synchronization via independent master timeline

🎛️ **Full Control** - Play, pause, stop, seek, and speed control

🎯 **User Interaction Detection** - Automatically pause on user clicks/keyboard input during replay

🎨 **Highly Customizable** - Extensive configuration options for recording and playback behavior

📦 **TypeScript Ready** - Full TypeScript support with comprehensive type definitions

## Installation

```bash
npm install use-scrimba
# or
yarn add use-scrimba
# or
pnpm add use-scrimba
```

## Quick Start

```tsx
import React, { useRef } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useScrimba, type Recording, type MouseCursorPosition } from 'use-scrimba';

function MyCodeEditor() {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  
  const {
    // Recording
    isRecording,
    startRecording,
    stopRecording,
    
    // Playback
    isPlaying,
    isPaused,
    play,
    pause,
    stop,
    seekTo,
    
    // Data
    currentRecording,
    
    // Handler for Monaco Editor
    handleEditorMount,
    handleEditorChange,
  } = useScrimba({
    editorRef,
    // Optional configuration
    onRecordingStart: () => console.log('Recording started'),
    onRecordingStop: (recording: Recording) => console.log('Recording stopped', recording),
    onPlaybackStart: () => console.log('Playback started'),
    onPlaybackPause: () => console.log('Playback paused'),
    pauseOnUserInteraction: true,
  });

  return (
    <div>
      {/* Controls */}
      <div>
        <button onClick={startRecording} disabled={isRecording}>
          Start Recording
        </button>
        <button onClick={stopRecording} disabled={!isRecording}>
          Stop Recording
        </button>
        <button onClick={play} disabled={!currentRecording || isPlaying}>
          Play
        </button>
        <button onClick={pause} disabled={!isPlaying}>
          Pause
        </button>
        <button onClick={stop} disabled={!currentRecording}>
          Stop
        </button>
      </div>

      {/* Monaco Editor */}
      <Editor
        height="400px"
        language="javascript"
        theme="vs-dark"
        onMount={(editor) => { 
          editorRef.current = editor; 
          handleEditorMount(editor); 
        }}
        onChange={handleEditorChange}
      />
    </div>
  );
}
```

## API Reference

### useScrimba(config)

The main hook that provides Scrimba functionality.

#### Configuration Options

```typescript
interface UseScrimbaConfig {
  // Required
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  
  // Optional Audio Sync
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  
  // Recording Options - All events are captured by default internally
  
  // Playback Options
  pauseOnUserInteraction?: boolean;  // Default: true
  defaultPlaybackSpeed?: number;     // Default: 1
  
  // Callbacks
  onRecordingStart?: () => void;
  onRecordingStop?: (recording: Recording) => void;
  onPlaybackStart?: () => void;
  onPlaybackPause?: () => void;
  onPlaybackEnd?: () => void;
  onSeek?: (time: number) => void;
  onError?: (error: Error) => void;
  
  // New granular callbacks
  onSnapshot?: (snapshot: EditorSnapshot) => void;
  onStateChange?: (state: EditorState) => void;
  onPlaybackUpdate?: (currentTime: number, snapshot: EditorSnapshot | null) => void;
  
  // Storage - Removed in latest version
  // Handle storage in your application layer
}
```

#### Return Value

```typescript
interface UseScrimbaReturn {
  // Recording State
  isRecording: boolean;
  recordingStartTime: number | null;
  
  // Playback State
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
  currentTime: number;
  playbackSpeed: number;
  
  // Data
  currentRecording: Recording | null;
  currentCursor: MouseCursorPosition | null;
  
  // Recording Controls
  startRecording: () => void;
  stopRecording: (options?: { audioBlob?: Blob }) => void;
  
  // Playback Controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  
  // Recording Management
  loadRecording: (recording: Recording) => void;
  
  // Monaco Editor Integration
  handleEditorMount: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  handleEditorChange: () => void;
  
  // Advanced
  getEditorState: () => EditorState | null;
  applyEditorState: (state: EditorState) => void;
  
  // New granular controls
  getSnapshot: (timestamp?: number) => EditorSnapshot | null;
  getCurrentState: () => { 
    recording: {
      isRecording: boolean;
      recordingStartTime: number | null;
      currentRecording: { snapshots: EditorSnapshot[]; duration: number; audioBlob?: Blob } | null;
    };
    playback: {
      isPlaying: boolean;
      isPaused: boolean;
      hasEnded: boolean;
      currentTime: number;
      playbackSpeed: number;
      loadedRecording: Recording | null;
      currentSnapshot: EditorSnapshot | null;
      editorState: EditorState;
    };
  };
  dispatch: (action: ScrimbaAction) => void;
  subscribe: (callback: () => void) => () => void;
}
```

## Advanced Usage

### Recording Management

Handle storage in your application layer:

```tsx
const scrimba = useScrimba({
  editorRef,
  onRecordingStop: (recording) => {
    // Save to your preferred storage solution
    saveRecording(recording);
  },
});

// Example storage functions (implement as needed)
const saveRecording = async (recording) => {
  // Local storage
  localStorage.setItem(`recording-${recording.id}`, JSON.stringify(recording));
  
  // Or API
  await fetch('/api/recordings', {
    method: 'POST',
    body: JSON.stringify(recording),
  });
};
```

### Audio Integration with Perfect Sync

```tsx
import React, { useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba, type Recording } from 'use-scrimba';

function AudioIntegratedEditor() {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const scrimba = useScrimba({
    editorRef,
    audioRef, // Enable perfect audio synchronization
    onRecordingStart: async () => {
      // Start audio recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        
        audioChunksRef.current = [];
        
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };
        
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach(track => track.stop());
        };
        
        mediaRecorder.start();
        setIsRecordingAudio(true);
        
      } catch (error) {
        console.error('Failed to start audio recording:', error);
      }
    },
    onRecordingStop: (recording: Recording) => {
      if (mediaRecorderRef.current && isRecordingAudio) {
        mediaRecorderRef.current.stop();
        setIsRecordingAudio(false);
      }
    },
  });
  
  // Custom stop recording with audio
  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecordingAudio) {
      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        scrimba.stopRecording({ audioBlob });
      };
      mediaRecorderRef.current.stop();
      setIsRecordingAudio(false);
    } else {
      scrimba.stopRecording();
    }
  };
  
  // Audio playback is automatically synchronized via audioRef!
  
  return (
    <div>
      {/* Hidden Audio Element - Managed by useScrimba for perfect sync */}
      <audio ref={audioRef} style={{ display: 'none' }} />
      
      <button onClick={scrimba.startRecording}>Start Recording</button>
      <button onClick={handleStopRecording}>Stop Recording</button>
      <button onClick={scrimba.play}>Play</button>
      
      {/* Editor */}
      <Editor
        onMount={(editor) => {
          editorRef.current = editor;
          scrimba.handleEditorMount(editor);
        }}
        onChange={scrimba.handleEditorChange}
      />
    </div>
  );
}
```

### Mouse Cursor Recording & Playback

```tsx
import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba, type MouseCursorPosition } from 'use-scrimba';

// Fake cursor component for playback visualization
interface FakeCursorProps {
  position: MouseCursorPosition;
}

const FakeCursor: React.FC<FakeCursorProps> = ({ position }) => {
  if (!position.visible) return null;

  return (
    <div
      style={{
        position: 'fixed', // Fixed to viewport
        left: position.x,
        top: position.y,
        width: 24,
        height: 24,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    >
      {/* Custom cursor icon */}
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path 
          d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z" 
          fill="white" 
          stroke="black" 
          strokeWidth="1"
        />
      </svg>
    </div>
  );
};

function EditorWithMouseCursor() {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  
  const scrimba = useScrimba({
    editorRef,
    // Mouse cursor recording is enabled by default
    onStateChange: (state) => {
      // Access real-time cursor data during recording
      if (state.mouseCursor) {
        console.log('Mouse at:', state.mouseCursor);
      }
    },
  });
  
  return (
    <>
      {/* Fake cursor during playback - positioned on viewport */}
      {scrimba.isPlaying && scrimba.currentCursor && scrimba.currentCursor.visible && (
        <FakeCursor position={scrimba.currentCursor} />
      )}
      
      <div>
        <button onClick={scrimba.startRecording}>Start Recording</button>
        <button onClick={scrimba.stopRecording}>Stop Recording</button>
        <button onClick={scrimba.play}>Play</button>
        
        {/* Show cursor coordinates during playback */}
        {scrimba.isPlaying && scrimba.currentCursor && (
          <div>
            🖱️ Cursor: ({scrimba.currentCursor.x}, {scrimba.currentCursor.y})
          </div>
        )}
        
        <Editor
          height="400px"
          onMount={(editor) => { 
            editorRef.current = editor; 
            scrimba.handleEditorMount(editor); 
          }}
          onChange={scrimba.handleEditorChange}
        />
      </div>
    </>
  );
}
```

### Seeking with Progress Bar

```tsx
function EditorWithProgress() {
  const scrimba = useScrimba({ editorRef });
  
  const handleSeek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const targetTime = percentage * scrimba.currentRecording?.duration || 0;
    scrimba.seekTo(targetTime);
  };
  
  return (
    <div>
      {/* Progress Bar */}
      <div 
        className="progress-bar"
        onClick={handleSeek}
        style={{ 
          width: '100%', 
          height: '8px', 
          backgroundColor: '#ddd',
          cursor: 'pointer' 
        }}
      >
        <div 
          className="progress"
          style={{
            width: `${(scrimba.currentTime / (scrimba.currentRecording?.duration || 1)) * 100}%`,
            height: '100%',
            backgroundColor: '#007acc'
          }}
        />
      </div>
      
      {/* Editor */}
      <Editor
        onMount={scrimba.handleEditorMount}
        onChange={scrimba.handleEditorChange}
      />
    </div>
  );
}
```

## Examples

### 📚 Available Examples

- **Basic Recording** - Simple editor recording without audio
- **Perfect Audio Sync** - Audio recording with millisecond-precise synchronization  
- **Mouse Cursor Recording** - Complete example with fake cursor during playback
- **Complete Demo** - Full-featured demo showcasing master timeline architecture

See the `/examples` folder in this package for complete implementation examples.

### 🎯 Perfect Synchronization

All audio examples use the **Independent Master Timeline** architecture:
- `performance.now()` as single source of truth
- Zero circular dependencies between audio and editor
- Millisecond-precise synchronization guaranteed
- Robust seeking without sync loss

```typescript
// Perfect synchronization with just audioRef!
const audioRef = useRef<HTMLAudioElement | null>(null);
const scrimba = useScrimba({
  editorRef,
  audioRef, // Enables millisecond-precise audio synchronization
  onPlaybackStart: () => console.log('Perfect sync started!'),
  onPlaybackUpdate: (currentTime, snapshot) => {
    console.log(`Master time: ${currentTime}ms, Snapshot: ${snapshot?.timestamp}ms`);
  },
});
```

## License

MIT
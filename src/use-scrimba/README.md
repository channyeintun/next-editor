# use-scrimba

A powerful React hook for recording and replaying Monaco Editor interactions with Scrimba-like functionality.

## Demo

🎬 **[Live Demo](https://scrim-demo.netlify.app/)** - See use-scrimba in action with recording and playback features!

## Features

🎥 **Record Editor Interactions** - Capture every keystroke, text cursor movement, selection, scroll event, and mouse cursor movements with precise timestamps

🎬 **Built-in Synchronized Audio Recording** - Millisecond-precise audio synchronization with zero drift

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
import { useScrimba, type Recording } from 'use-scrimba';

function MyCodeEditor() {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  const {
    // Recording
    isRecording,
    isRecordingAudio,
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
    handleEditorChange,
  } = useScrimba({
    editorRef,
    audioRef,
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    onRecordingStart: () => console.log('Synchronized recording started'),
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
          {isRecording ? `Recording${isRecordingAudio ? ' + Audio' : ''}` : 'Start Recording'}
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

      {/* Hidden Audio Element for synchronized playback */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* Monaco Editor */}
      <Editor
        height="400px"
        language="javascript"
        theme="vs-dark"
        onMount={(editor) => { 
          editorRef.current = editor; 
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
  
  // Optional Audio Recording
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  enableAudioRecording?: boolean;    // Enable built-in synchronized audio recording
  
  // Recording Options
  captureEvents?: CaptureEvents;     // Customize what events to capture
  
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
  isRecordingAudio: boolean;         // Built-in audio recording state
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
  startRecording: () => Promise<void>; // Now async for synchronized audio
  stopRecording: (options?: { audioBlob?: Blob; masterDuration?: number }) => Promise<void>;
  
  // Playback Controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  
  // Recording Management
  loadRecording: (recording: Recording) => void;
  
  // Monaco Editor Integration
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

### Built-in Synchronized Audio Recording

```tsx
import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba, type Recording } from 'use-scrimba';

function AudioIntegratedEditor() {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  const {
    isRecording,
    isRecordingAudio,
    startRecording,
    stopRecording,
    play,
    handleEditorChange,
    currentRecording
  } = useScrimba({
    editorRef,
    audioRef,
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    onRecordingStart: () => {
      console.log('🎬 Synchronized recording started');
    },
    onRecordingStop: (recording: Recording) => {
      console.log('⏹️ Synchronized recording stopped');
      console.log('🎵 Audio included:', !!recording.audioBlob);
      console.log('📏 Duration:', recording.duration, 'ms (synchronized)');
    },
  });
  
  return (
    <div>
      {/* Hidden Audio Element - Managed by useScrimba for perfect sync */}
      <audio ref={audioRef} style={{ display: 'none' }} />
      
      <div>
        <button onClick={startRecording} disabled={isRecording}>
          {isRecording ? `Recording${isRecordingAudio ? ' + Audio' : ''}` : 'Start Recording'}
        </button>
        <button onClick={stopRecording} disabled={!isRecording}>
          Stop Recording
        </button>
        <button onClick={play} disabled={!currentRecording}>
          Play Synchronized
        </button>
      </div>
      
      {/* Editor */}
      <Editor
        height="400px"
        onMount={(editor) => {
          editorRef.current = editor;
        }}
        onChange={handleEditorChange}
      />
    </div>
  );
}
```

### Master Timeline Architecture

The built-in audio recording uses a **Master Timeline** approach:

- **Single Start Timestamp**: Both audio and snapshot recording start with identical `masterStartTime`
- **Single Stop Timestamp**: Both recordings stop with identical `masterStopTime`  
- **Zero Drift**: Timeline duration = `stopTime - startTime` (same for both systems)
- **Perfect Synchronization**: No async timing mismatches between audio and snapshots

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
        onMount={(editor) => { editorRef.current = editor; }}
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

### 🎯 Synchronized Recording Architecture

**Master Timeline Synchronization**:
- Single `masterStartTime` for both audio and snapshot recording start
- Single `masterStopTime` for both audio and snapshot recording stop
- Identical duration calculation: `masterStopTime - masterStartTime`
- Zero drift between audio and code changes

```typescript
// Built-in synchronized recording with master timeline
const audioRef = useRef<HTMLAudioElement | null>(null);
const scrimba = useScrimba({
  editorRef,
  audioRef,
  enableAudioRecording: true, // Enables synchronized audio recording
  onRecordingStart: () => console.log('🎬 Master timeline started'),
  onRecordingStop: (recording) => {
    console.log('📏 Synchronized duration:', recording.duration, 'ms');
    console.log('🎵 Audio synchronized:', !!recording.audioBlob);
  },
});
```

**Key Benefits**:
- **Rearchitected Solution**: Audio recording moved into use-scrimba package
- **Breaking Change**: No more separate audio recording logic needed in main project
- **Master Timeline**: Single source of truth for recording timing
- **Zero Configuration**: Just set `enableAudioRecording: true`

## License

MIT
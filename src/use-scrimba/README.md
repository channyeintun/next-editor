# use-scrimba

A powerful React hook for recording and replaying Monaco Editor interactions with Scrimba-like functionality.

## Features

🎥 **Record Editor Interactions** - Capture every keystroke, text cursor movement, selection, and mouse cursor movements with precise timestamps

🎬 **Built-in Synchronized Audio Recording** - Millisecond-precise audio synchronization with zero drift using master timeline architecture

🎛️ **Full Control** - Play, pause, stop, seek, and speed control

🎯 **User Interaction Detection** - Automatically pause on user clicks/keyboard input during replay

🎨 **Highly Customizable** - Extensive configuration options for recording and playback behavior

📦 **TypeScript Ready** - Full TypeScript support with comprehensive type definitions

## Demo

🎬 **[Live Demo](https://scrim-demo.vercel.app/)** - See use-scrimba in action with recording and playback features!

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
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    onRecordingStart: () => console.log('Synchronized recording started'),
    onRecordingStop: (recording: Recording) => console.log('Recording stopped', recording),
    onPlaybackStart: () => console.log('Playback started'),
    onPlaybackPause: () => console.log('Playback paused'),
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
  
  // Audio Recording
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
  
  // Granular callbacks
  onSnapshot?: (snapshot: EditorSnapshot) => void;
  onStateChange?: (state: EditorState) => void;
  onPlaybackUpdate?: (currentTime: number, snapshot: EditorSnapshot | null) => void;
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
  volume: number;
  
  // Data
  currentRecording: Recording | null;
  currentCursor: MouseCursorPosition | null;
  actualDuration: number;
  
  // Recording Controls
  startRecording: () => Promise<void>; // Async for synchronized audio
  stopRecording: () => Promise<void>;
  
  // Playback Controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  
  // Recording Management
  loadRecording: (recording: Recording) => void;
  
  // Monaco Editor Integration
  handleEditorChange: () => void;
  
  // Helper functions
  getEditorState: () => EditorState | null;
  getSnapshot: (timestamp?: number) => EditorSnapshot | null;
}
```

## Key Benefits

### ✅ Rearchitected Solution
- Audio recording moved into use-scrimba package
- No more separate audio recording logic needed in main project
- Single source of truth for recording timing

### ✅ Master Timeline
- Both audio and snapshots use identical start/stop timestamps
- Zero drift between audio and code changes
- Perfect synchronization guaranteed

### ✅ Zero Configuration
- Just set `enableAudioRecording: true`
- No external audio element management

## License

MIT
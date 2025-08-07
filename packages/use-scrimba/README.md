# use-scrimba

A powerful React hook for recording and replaying Monaco Editor interactions with Scrimba-like functionality.

## Features

🎥 **Record Editor Interactions** - Capture every keystroke, cursor movement, selection, and scroll event with precise timestamps

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
import { useScrimba } from 'use-scrimba';

function MyCodeEditor() {
  const editorRef = useRef(null);
  
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
    recordings,
    currentRecording,
    
    // Handler for Monaco Editor
    handleEditorMount,
    handleEditorChange,
  } = useScrimba({
    editorRef,
    // Optional configuration
    onRecordingStart: () => console.log('Recording started'),
    onRecordingStop: (recording) => console.log('Recording stopped', recording),
    onPlaybackEnd: () => console.log('Playback ended'),
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
  
  // Recording Options
  captureEvents?: {
    content?: boolean;          // Default: true
    cursorPosition?: boolean;   // Default: true
    selection?: boolean;        // Default: true
    scroll?: boolean;           // Default: true
  };
  
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
  
  // Storage
  storage?: {
    save?: (recording: Recording) => Promise<void>;
    load?: () => Promise<Recording[]>;
    delete?: (id: string) => Promise<void>;
  };
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
  recordings: Recording[];
  currentRecording: Recording | null;
  currentSnapshot: EditorSnapshot | null;
  
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
  deleteRecording: (id: string) => void;
  clearRecordings: () => void;
  
  // Monaco Editor Integration
  handleEditorMount: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  handleEditorChange: () => void;
  
  // Advanced
  getEditorState: () => EditorState | null;
  applyEditorState: (state: EditorState) => void;
}
```

## Advanced Usage

### Custom Storage Provider

```tsx
const storage = {
  save: async (recording) => {
    await fetch('/api/recordings', {
      method: 'POST',
      body: JSON.stringify(recording),
    });
  },
  load: async () => {
    const response = await fetch('/api/recordings');
    return response.json();
  },
  delete: async (id) => {
    await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
  },
};

const scrimba = useScrimba({
  editorRef,
  storage,
});
```

### Audio Integration

```tsx
function AudioIntegratedEditor() {
  const [audioBlob, setAudioBlob] = useState(null);
  const mediaRecorderRef = useRef(null);
  
  const scrimba = useScrimba({
    editorRef,
    onRecordingStart: () => {
      // Start audio recording
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
          mediaRecorderRef.current = new MediaRecorder(stream);
          mediaRecorderRef.current.start();
        });
    },
    onRecordingStop: (recording) => {
      // Stop audio recording and attach to recording
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.ondataavailable = (e) => {
        scrimba.stopRecording({ audioBlob: e.data });
      };
    },
  });
  
  // ... rest of component
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

- **[Basic Recording](./examples/basic)** - Simple editor recording without audio
- **[Perfect Audio Sync](./examples/with-audio)** - Audio recording with millisecond-precise synchronization  
- **[Complete Demo](./examples/perfect-sync)** - Full-featured demo showcasing master timeline architecture

### 🎯 Perfect Synchronization

All audio examples use the **Independent Master Timeline** architecture:
- `performance.now()` as single source of truth
- Zero circular dependencies between audio and editor
- Millisecond-precise synchronization guaranteed
- Robust seeking without sync loss

```typescript
// Just add audioRef for perfect sync!
const scrimba = useScrimba({
  editorRef,
  audioRef, // Enables perfect audio synchronization
  onPlaybackStart: () => console.log('Perfect sync started!'),
});
```

## License

MIT
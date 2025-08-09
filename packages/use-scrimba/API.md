# use-scrimba API Reference

## Table of Contents

- [useScrimba Hook](#usescrimba-hook)
- [Configuration](#configuration)
- [Return Value](#return-value)
- [Types](#types)
- [Advanced Usage](#advanced-usage)
- [Examples](#examples)

## useScrimba Hook

The main hook that provides Scrimba-like recording and playback functionality.

```typescript
const scrimba = useScrimba(config: UseScrimbaConfig): UseScrimbaReturn
```

## Configuration

### UseScrimbaConfig

```typescript
interface UseScrimbaConfig {
  // Required
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  
  // Optional Recording Settings
  captureEvents?: CaptureEvents;
  
  // Optional Playback Settings
  pauseOnUserInteraction?: boolean;
  defaultPlaybackSpeed?: number;
  
  // Optional Callbacks
  onRecordingStart?: () => void;
  onRecordingStop?: (recording: Recording) => void;
  onPlaybackStart?: () => void;
  onPlaybackPause?: () => void;
  onPlaybackEnd?: () => void;
  onSeek?: (time: number) => void;
  onError?: (error: Error) => void;
  
}
```

### CaptureEvents

Control which editor events are captured during recording:

```typescript
interface CaptureEvents {
  content?: boolean;          // Default: true - Content changes
  cursorPosition?: boolean;   // Default: true - Cursor movements
  selection?: boolean;        // Default: true - Text selections
  scroll?: boolean;           // Default: true - Scroll changes
}
```

## Return Value

### UseScrimbaReturn

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

## Types

### Recording

Complete recording with metadata:

```typescript
interface Recording {
  id: string;              // Unique identifier
  name: string;            // Human-readable name
  snapshots: EditorSnapshot[]; // Array of timestamped states
  audioBlob?: Blob;        // Optional audio data
  duration: number;        // Total duration in milliseconds
  createdAt: number;       // Creation timestamp
}
```

### EditorSnapshot

State capture at a specific timestamp:

```typescript
interface EditorSnapshot {
  timestamp: number;       // Time from recording start (ms)
  state: {
    content: string;                                     // Full editor content
    selection: monaco.Selection;                         // Text selection
    position: monaco.Position;                          // Cursor position
    viewState: monaco.editor.ICodeEditorViewState | null; // Scroll, etc.
  };
}
```

### EditorState

Current editor state for manipulation:

```typescript
interface EditorState {
  content: string;
  selection: monaco.Selection;
  position: monaco.Position;
  viewState: monaco.editor.ICodeEditorViewState | null;
}
```

## Advanced Usage

### Custom Event Capture

```typescript
const scrimba = useScrimba({
  editorRef,
  captureEvents: {
    content: true,        // Capture text changes
    cursorPosition: true, // Capture cursor movements
    selection: false,     // Skip text selections
    scroll: false,        // Skip scroll changes
  },
});
```

### Recording Management

```typescript
const scrimba = useScrimba({
  editorRef,
  onRecordingStop: (recording) => {
    // Handle storage in your application
    saveToDatabase(recording);
    // or
    localStorage.setItem('recordings', JSON.stringify(recording));
  },
});
```

### Error Handling

```typescript
const scrimba = useScrimba({
  editorRef,
  onError: (error) => {
    console.error('Scrimba error:', error);
    // Show user notification
    toast.error(error.message);
  },
});
```

### Playback Speed Control

```typescript
const scrimba = useScrimba({
  editorRef,
  defaultPlaybackSpeed: 1.5, // 1.5x speed
});

// Change speed during playback
const handleSpeedChange = (speed: number) => {
  scrimba.setPlaybackSpeed(speed);
};
```

### Direct State Manipulation

```typescript
const scrimba = useScrimba({ editorRef });

// Get current editor state
const currentState = scrimba.getEditorState();

// Apply a saved state
const savedState: EditorState = {
  content: 'console.log("Hello World");',
  position: { lineNumber: 1, column: 27 },
  selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 27 },
  viewState: null,
};

scrimba.applyEditorState(savedState);
```

## Examples

### Basic Implementation

```typescript
import { useScrimba } from 'use-scrimba';

const MyEditor = () => {
  const editorRef = useRef(null);
  const scrimba = useScrimba({ editorRef });

  return (
    <div>
      <button onClick={scrimba.startRecording}>Record</button>
      <button onClick={scrimba.stopRecording}>Stop</button>
      <button onClick={scrimba.play}>Play</button>
      
      <Editor
        onMount={(editor) => { 
          editorRef.current = editor; 
          scrimba.handleEditorMount(editor); 
        }}
        onChange={scrimba.handleEditorChange}
      />
    </div>
  );
};
```

### With Progress Bar

```typescript
const ProgressBar = ({ scrimba }) => {
  const { currentTime, currentRecording } = scrimba;
  
  if (!currentRecording) return null;
  
  const progress = (currentTime / currentRecording.duration) * 100;
  
  return (
    <div 
      className="progress-bar"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percentage = clickX / rect.width;
        const targetTime = percentage * currentRecording.duration;
        scrimba.seekTo(targetTime);
      }}
    >
      <div 
        className="progress-fill"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
};
```

### Multiple Recordings Management

```typescript
const RecordingsList = ({ scrimba }) => {
  const { recordings, currentRecording, loadRecording, deleteRecording } = scrimba;

  return (
    <div>
      {recordings.map(recording => (
        <div key={recording.id} className="recording-item">
          <span>{recording.name}</span>
          <span>{recording.duration}ms</span>
          <button onClick={() => loadRecording(recording)}>
            Load
          </button>
          <button onClick={() => deleteRecording(recording.id)}>
            Delete
          </button>
        </div>
      ))}
    </div>
  );
};
```

### Keyboard Shortcuts

```typescript
const EditorWithShortcuts = () => {
  const scrimba = useScrimba({ editorRef });

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 'r':
            e.preventDefault();
            scrimba.isRecording ? scrimba.stopRecording() : scrimba.startRecording();
            break;
          case ' ':
            e.preventDefault();
            scrimba.isPlaying ? scrimba.pause() : scrimba.play();
            break;
          case 's':
            e.preventDefault();
            scrimba.stop();
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [scrimba]);

  // ... rest of component
};
```

This API provides complete control over the recording and playback functionality while maintaining simplicity for basic use cases.
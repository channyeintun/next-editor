# use-scrimba Package Architecture

## Overview

The `use-scrimba` package provides a React hook for creating Scrimba-like interactive coding experiences with perfect audio synchronization. It captures Monaco Editor state changes and replays them in sync with audio narration using an innovative independent master timeline architecture.

## Core Innovation: Independent Master Timeline

### Problem Solved
Traditional approaches create circular dependencies where audio drives editor state or vice versa, causing timing drift and synchronization issues.

### Solution: Master Timeline Architecture
```
performance.now() Master Timeline (Independent Source of Truth)
    ├─ Audio Element (Slave) 
    ├─ Monaco Editor (Slave)
    └─ Redux State (Slave)
```

**Key Benefits:**
- **Zero Circular Dependencies**: Neither audio nor editor drives the other
- **Millisecond Precision**: High-resolution `performance.now()` timing
- **Perfect Synchronization**: All updates in same `requestAnimationFrame`
- **Robust Seeking**: Timeline resets maintain sync during scrubbing

## Package Structure

```
packages/use-scrimba/
├── src/
│   ├── index.ts              # Main exports
│   ├── useScrimba.ts         # Primary hook with master timeline
│   ├── types.ts              # TypeScript interfaces
│   ├── store/                # Redux Toolkit state management
│   │   ├── index.ts          # Store creation and exports
│   │   ├── recordingSlice.ts # Recording state management
│   │   ├── playbackSlice.ts  # Playback state management
│   │   └── recordingsSlice.ts# Recordings library management
│   ├── hooks/                # Internal specialized hooks
│   │   ├── useRecording.ts   # Monaco Editor event capture
│   │   └── usePlayback.ts    # Monaco Editor state application
│   └── utils/                # Utility functions
│       └── validation.ts     # Editor state validation
├── examples/                 # Usage examples
├── dist/                     # Built package output
├── package.json
├── rollup.config.js         # Build configuration
└── tsconfig.json           # TypeScript configuration
```

## Core Architecture Components

### 1. useScrimba Hook (`src/useScrimba.ts`)
**Primary Interface**: Main hook that orchestrates recording and playback

**Master Timeline Implementation:**
```typescript
const masterTimelineUpdate = () => {
  // Independent time source using performance.now()
  const elapsed = performance.now() - masterTimelineStartRef.current.perfTime;
  const masterTime = masterTimelineStartRef.current.currentTime + (elapsed * currentState.playbackSpeed);
  
  // Update Redux state
  store.dispatch(updateCurrentTime(masterTime));
  
  // Sync audio to master timeline
  audio.currentTime = masterTime / 1000;
  
  // Apply editor state synchronously
  editor.setValue(newState.content);
  editor.setPosition(newState.position);
  editor.setSelection(newState.selection);
};
```

**Key Features:**
- Independent `performance.now()` based timing
- Audio synchronization via `audioRef` parameter
- Direct Monaco Editor manipulation
- Redux state management
- Seeking support with timeline reset

### 2. State Management (`src/store/`)

**Redux Toolkit Architecture:**
- **recordingSlice**: Manages recording state, current recording data
- **playbackSlice**: Controls playback state, current time, loaded recording
- **recordingsSlice**: Handles recordings library, CRUD operations

**Key Actions:**
```typescript
// Playback control
play(), pause(), stop(), end()
updateCurrentTime(time)
seekTo(time)
setPlaybackSpeed(speed)

// Recording management  
startRecording(), stopRecording()
loadRecording(recording)
```

### 3. Recording Hook (`src/hooks/useRecording.ts`)
**Purpose**: Captures Monaco Editor events during recording

**Event Capture:**
- `onDidChangeContent` → Full content snapshots
- `onDidChangeCursorPosition` → Cursor coordinates
- `onDidChangeCursorSelection` → Selection ranges  
- `onDidScrollChange` → Scroll positions

**Snapshot Structure:**
```typescript
interface EditorSnapshot {
  timestamp: number;
  state: {
    content: string;
    selection: monaco.Selection;
    position: monaco.Position;
    viewState: monaco.editor.ICodeEditorViewState | null;
  };
}
```

### 4. Playback Hook (`src/hooks/usePlayback.ts`)
**Purpose**: Applies editor state during replay

**Features:**
- State validation before application
- Safe position/selection bounds checking
- View state restoration
- User interaction prevention during replay

### 5. Type System (`src/types.ts`)
**Core Interfaces:**

```typescript
// Main hook configuration
interface UseScrimbaConfig {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  audioRef?: RefObject<HTMLAudioElement | null>; // Audio sync support
  pauseOnUserInteraction?: boolean;
  // Callbacks for granular control
  onRecordingStart?: () => void;
  onPlaybackUpdate?: (currentTime: number, snapshot: EditorSnapshot | null) => void;
}

// Complete recording with metadata
interface Recording {
  id: string;
  name: string;
  snapshots: EditorSnapshot[];
  audioBlob?: Blob; // Audio synchronization
  duration: number;
  createdAt: number;
}
```

## Synchronization Flow

### Recording Flow
```
1. User starts recording
2. Monaco Editor events captured via useRecording hook
3. Each event creates timestamped snapshot
4. Audio recording runs in parallel (external to package)
5. Stop recording combines snapshots with audio blob
```

### Playback Flow (Master Timeline)
```
1. Load recording with snapshots and audio blob
2. Initialize master timeline reference:
   masterTimelineStartRef.current = {
     perfTime: performance.now(),
     currentTime: initialTime
   }

3. requestAnimationFrame loop:
   a. Calculate master time from performance.now()
   b. Update Redux state
   c. Sync audio.currentTime to master time
   d. Find appropriate snapshot for current time
   e. Apply snapshot to Monaco Editor directly
   f. Continue loop until ended

4. Seeking resets master timeline reference:
   masterTimelineStartRef.current = {
     perfTime: performance.now(),
     currentTime: seekTime
   }
```

## API Design Philosophy

### Simplicity
```typescript
// Simple configuration with audioRef for perfect sync
const scrimba = useScrimba({
  editorRef,
  audioRef, // Just add this for audio synchronization
  onRecordingStart: () => console.log('Recording started'),
  onPlaybackUpdate: (time, snapshot) => console.log('Playback update')
});
```

### Flexibility
```typescript
// Advanced usage with granular callbacks
const scrimba = useScrimba({
  editorRef,
  audioRef,
  // All events captured by default internally
  pauseOnUserInteraction: true,
  onSnapshot: (snapshot) => logSnapshot(snapshot),
  onStateChange: (state) => updateUI(state),
  onRecordingStop: (recording) => saveRecording(recording)
});
```

### Extensibility
```typescript
// Access to internal state and dispatch for custom behavior
const currentState = scrimba.getCurrentState();
scrimba.dispatch(customAction());

// Batch operations
scrimba.loadMultipleRecordings(recordings);
const exported = scrimba.exportRecording(id, 'compressed');
```

## Performance Optimizations

### 1. Direct Monaco Manipulation
- Bypasses React re-render cycle during playback
- Synchronous editor state application
- Zero latency between audio and editor updates

### 2. Efficient State Management
- Redux Toolkit for optimized state updates
- Selective snapshot application (only when different)
- View state restoration only when stable

### 3. Memory Management
- Automatic cleanup of audio URLs
- Timeline reference reset on stop/end
- Event listener cleanup on component unmount

### 4. Validation Layer
```typescript
// Safe state application with bounds checking
const isValidEditorState = (state: EditorState) => {
  return state && 
         typeof state.content === 'string' &&
         state.position && 
         state.selection &&
         state.position.lineNumber > 0;
};
```

## Integration Patterns

### Basic Integration
```typescript
function MyEditor() {
  const editorRef = useRef(null);
  const audioRef = useRef(null);
  
  const scrimba = useScrimba({
    editorRef,
    audioRef
  });
  
  return (
    <>
      <MonacoEditor 
        onMount={(editor) => editorRef.current = editor}
        onChange={scrimba.handleEditorChange}
      />
      <audio ref={audioRef} style={{ display: 'none' }} />
      <MediaControls 
        onPlay={scrimba.play}
        onPause={scrimba.pause}
        onSeek={scrimba.seekTo}
      />
    </>
  );
}
```

### Advanced Integration with Context
```typescript
// Provider level
function ScrimbaProvider({ children }) {
  const editorRef = useRef(null);
  const audioRef = useRef(null);
  
  const scrimba = useScrimba({
    editorRef,
    audioRef,
    onRecordingStop: (recording) => handleRecordingSave(recording)
  });
  
  return (
    <ScrimbaContext.Provider value={{ ...scrimba, editorRef, audioRef }}>
      {children}
    </ScrimbaContext.Provider>
  );
}
```

## Future Enhancements

### 1. WebCodecs Integration
- Hardware-accelerated video recording
- More efficient media handling

### 2. WebRTC Support  
- Real-time collaborative recording
- Live streaming capabilities

### 3. Advanced Analytics
- Playback analytics and insights
- User interaction tracking

### 4. Plugin Architecture
- Custom event capture plugins
- Extended replay behaviors

## Testing Strategy

### Unit Tests
- Hook behavior testing with React Testing Library
- State management validation
- Snapshot creation and application

### Integration Tests  
- Monaco Editor integration
- Audio synchronization accuracy
- Seeking behavior validation

### Performance Tests
- Timeline precision measurement
- Memory leak detection
- Large recording handling

## Migration Guide

### From Previous Versions
```typescript
// Old approach (circular dependency)
useEffect(() => {
  if (audio.currentTime !== editorTime) {
    updateEditor(audio.currentTime);
  }
}, [audio.currentTime]);

// New approach (master timeline)
const scrimba = useScrimba({
  editorRef,
  audioRef // Package handles synchronization automatically
});
```

This architecture provides a robust, performant, and developer-friendly foundation for building interactive coding experiences with perfect audio synchronization.
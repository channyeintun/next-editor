# Interactive Coding Platform (Scrimba-like)

A React + TypeScript application that provides Scrimba-like interactive coding functionality, allowing users to record Monaco Editor state changes synchronized with audio narration and replay them perfectly.

## Overview

This project demonstrates the power of the **use-scrimba** package - a React hook that captures every keystroke, cursor movement, selection change, and scroll event in Monaco Editor with precise timestamps. The app can replay these events in perfect synchronization with audio, creating an authentic coding tutorial experience.

## Key Features

- 🎤 **Audio Recording**: Simultaneous microphone capture during coding sessions
- 🎬 **Editor Replay**: Frame-perfect reconstruction of coding sessions with millisecond precision
- ⏯️ **Media Controls**: Play, pause, stop, seek with variable speed control
- 💾 **Recording Management**: Save and load recordings via callbacks
- 🔄 **Perfect Sync**: Independent master timeline ensures zero-drift audio/editor synchronization
- 📱 **Responsive UI**: Clean interface with visual recording indicators
- 🎯 **Monaco Integration**: Full Monaco Editor support with TypeScript, syntax highlighting

## Technology Stack

- **React** with TypeScript
- **use-scrimba package** - Custom React hook for recording/replay functionality
- **@monaco-editor/react** - Monaco Editor integration
- **MediaRecorder API** - Audio capture
- **HTML5 Audio API** - Synchronized audio playback
- **Redux Toolkit** - State management (via use-scrimba)
- **React Context API** - Global state sharing

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Run linting
npm run lint

# Type checking
npm run typecheck
```

## Project Structure

```
├── src/
│   ├── components/
│   │   ├── CodeEditor.tsx      # Monaco Editor wrapper with use-scrimba
│   │   ├── AudioPlayer.tsx     # Hidden audio element for playback
│   │   ├── MediaControls.tsx   # Play/pause/seek controls
│   │   └── RecordingsList.tsx  # Library of saved recordings
│   ├── contexts/
│   │   ├── ScrimbaContext.tsx  # React Context provider
│   │   └── ScrimbaContext.ts   # Context types
│   ├── hooks/
│   │   ├── useScrimbaContext.ts # Hook to access context
│   │   └── useAudioRecording.ts # Audio recording logic
│   └── storage/
│       ├── JsonStorage.ts      # Local storage adapter
│       └── SuperJsonConfig.ts  # SuperJSON configuration
└── packages/use-scrimba/       # The core package
    ├── src/
    │   ├── useScrimba.ts       # Main hook
    │   ├── types.ts            # TypeScript definitions
    │   ├── hooks/              # Internal hooks
    │   ├── store/              # Redux store
    │   └── utils/              # Utilities
    └── examples/               # Usage examples
```

## use-scrimba Package

### Installation

```bash
npm install use-scrimba @monaco-editor/react
```

### Basic Usage

```typescript
import { useScrimba } from 'use-scrimba';
import Editor from '@monaco-editor/react';

const MyEditor = () => {
  const editorRef = useRef(null);
  const audioRef = useRef(null);
  
  const scrimba = useScrimba({
    editorRef,
    audioRef, // Optional: for audio sync
    onRecordingStop: (recording) => {
      console.log('Recording saved:', recording);
    },
  });

  return (
    <div>
      <button onClick={scrimba.startRecording}>Record</button>
      <button onClick={scrimba.stopRecording}>Stop</button>
      <button onClick={scrimba.play}>Play</button>
      <button onClick={scrimba.pause}>Pause</button>
      
      <Editor
        onMount={(editor) => {
          editorRef.current = editor;
          scrimba.handleEditorMount(editor);
        }}
        onChange={scrimba.handleEditorChange}
      />
      
      <audio ref={audioRef} />
    </div>
  );
};
```

### API Overview

The useScrimba hook provides:

**Recording State:**
- `isRecording: boolean` - Recording status
- `recordingStartTime: number | null` - Start timestamp

**Playback State:**
- `isPlaying: boolean` - Playback status
- `isPaused: boolean` - Pause status  
- `hasEnded: boolean` - Completion status
- `currentTime: number` - Current playback position
- `playbackSpeed: number` - Playback speed multiplier

**Controls:**
- `startRecording()` - Start recording
- `stopRecording(options?)` - Stop recording with optional audio
- `play()` - Start playback
- `pause()` - Pause playback
- `stop()` - Stop and reset
- `seekTo(time)` - Jump to timestamp
- `setPlaybackSpeed(speed)` - Change playback speed

**Data Management:**
- `currentRecording: Recording | null` - Loaded recording
- `currentSnapshot: EditorSnapshot | null` - Current editor state
- `loadRecording(recording)` - Load recording for playback

**Advanced:**
- `getEditorState()` - Get current editor state
- `applyEditorState(state)` - Apply editor state
- `getSnapshot(timestamp?)` - Get snapshot at time
- `getCurrentState()` - Get Redux state
- `dispatch(action)` - Dispatch Redux action
- `subscribe(callback)` - Subscribe to state changes

## Architecture

### Master Timeline System

The core innovation is the **Independent Master Timeline** that eliminates synchronization drift:

```
performance.now() Master Timeline
    ├─ Audio Element (slave)
    └─ Editor State (slave)
```

**Benefits:**
- **Zero Latency**: Audio and editor updates in same `requestAnimationFrame`
- **Perfect Seeking**: Timeline resets maintain sync during scrubbing
- **No Drift**: High-precision `performance.now()` prevents timing errors
- **Clean Audio**: Proper pause/stop prevents audio artifacts

### Recording Process

1. **Capture Events**: Monaco Editor events captured via useScrimba:
   - `onDidChangeContent` → Content snapshots
   - `onDidChangeCursorPosition` → Cursor coordinates
   - `onDidChangeCursorSelection` → Selection ranges
   - `onDidScrollChange` → Scroll positions

2. **Timestamps**: Each event gets precise timestamp from recording start

3. **Audio Sync**: MediaRecorder API captures audio in parallel

4. **Callback**: Complete recording (snapshots + audio) returned via callback

### Playback Process

1. **Master Timeline**: Independent `performance.now()` based timing
2. **Synchronized Updates**: Audio and editor updated in same frame
3. **Direct Manipulation**: Editor updated directly via Monaco API
4. **State Reconstruction**: Editor state rebuilt from snapshots

## Examples

The package includes comprehensive examples in `packages/use-scrimba/examples/`:

- **Basic Example**: Simple recording/playback
- **Audio Example**: With synchronized audio
- **Perfect Sync Example**: Advanced timeline synchronization

## TypeScript Support

Full TypeScript support with comprehensive type definitions:

```typescript
import type { 
  UseScrimbaConfig,
  UseScrimbaReturn,
  Recording,
  EditorSnapshot,
  EditorState 
} from 'use-scrimba';
```

## Development

### Local Development

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Package Development

```bash
# Navigate to package
cd packages/use-scrimba

# Build the package
npm run build

# Run tests
npm test

# Development mode
npm run dev
```

## License

MIT License - see LICENSE file for details

## Links

- [use-scrimba on npm](https://www.npmjs.com/package/use-scrimba)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [React](https://reactjs.org/)
- [TypeScript](https://www.typescriptlang.org/)

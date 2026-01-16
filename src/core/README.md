# use-next-editor

A powerful React hook for recording and replaying Monaco Editor interactions.

## Features

🎥 **Record Editor Interactions** - Capture every keystroke, text cursor
movement, selection, and mouse cursor movements with precise timestamps

🎬 **Built-in Synchronized Audio Recording** - Millisecond-precise audio
synchronization with zero drift using master timeline architecture

🎛️ **Full Control** - Play, pause, stop, seek, and speed control

🎯 **User Interaction Detection** - Automatically pause on user clicks/keyboard
input during replay

🎨 **Highly Customizable** - Extensive configuration options for recording and
playback behavior

🎞️ **Slide Presentations** - Record and replay slide presentations with
synchronized state

🚀 **WebAssembly Powered** - High-performance steganography core
powered strictly by AssemblyScript for ultra-fast encoding and decoding

## Why WebAssembly?

Steganography involves intensive bitwise operations on large arrays of pixel data. This module uses WebAssembly (Wasm) exclusively to provide predictable, high-performance encoding and decoding. By using AssemblyScript, we maintain a TypeScript-like codebase that compiles to a highly efficient binary.

## Installation

```bash
npm install use-next-editor
# or
yarn add use-next-editor
# or
pnpm add use-next-editor
```

## Quick Start

```tsx
import React, { useRef } from "react";
import Editor from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { type Recording, useNextEditor } from "use-next-editor";

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
  } = useNextEditor({
    editorRef,
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    onRecordingStart: () => console.log("Synchronized recording started"),
    onRecordingStop: (recording: Recording) =>
      console.log("Recording stopped", recording),
    onPlaybackStart: () => console.log("Playback started"),
    onPlaybackPause: () => console.log("Playback paused"),
  });

  return (
    <div>
      {/* Controls */}
      <div>
        <button onClick={startRecording} disabled={isRecording}>
          {isRecording
            ? `Recording${isRecordingAudio ? " + Audio" : ""}`
            : "Start Recording"}
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

### useNextEditor(config)

The main hook that provides Next Editor functionality.

#### Configuration Options

```typescript
interface UseNextEditorConfig {
  // Required
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;

  // Audio Recording
  enableAudioRecording?: boolean; // Enable built-in synchronized audio recording

  // Playback Options
  pauseOnUserInteraction?: boolean; // Default: true
  defaultPlaybackSpeed?: number; // Default: 1

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
  onPlaybackUpdate?: (
    currentTime: number,
    snapshot: EditorSnapshot | null,
  ) => void;

  // Slide integration callbacks
  onSlideEvent?: (event: SlideEvent) => void;
  getSlideState?: () => {
    previewState: SlidePreviewState;
    currentSlideIndex: number;
  } | null;
  applySlideState?: (
    slideState: SlidePreviewState,
    currentSlideIndex: number,
  ) => void;
  getSlides?: () =>
    | Array<{ id: string; imageUrl: string; name?: string; order: number }>
    | null;
  applySlides?: (
    slides: Array<
      { id: string; imageUrl: string; name?: string; order: number }
    >,
  ) => void;
}
```

#### Return Value

```typescript
interface UseNextEditorReturn {
  // Recording State
  isRecording: boolean;
  isRecordingAudio: boolean; // Built-in audio recording state
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
  handleSlideEvent: (event: SlideEvent) => void;

  // Helper functions
  getEditorState: () => EditorState | null;
  getSnapshot: (timestamp?: number) => EditorSnapshot | null;
}
```

## Slide Presentations

useNextEditor supports recording and replaying slide presentations alongside code
changes. This feature allows you to create interactive tutorials with
synchronized slides.

### Slide Integration

To integrate slides with your recordings, you need to provide getter and setter
functions for slide state and slide data:

```typescript
const {
  // ... other useNextEditor return values
  handleSlideEvent,
} = useNextEditor({
  editorRef,
  enableAudioRecording: true,

  // Slide state callbacks
  getSlideState: () => ({
    previewState: {
      isOpen: boolean, // Whether slides are visible
      isMaximized: boolean, // Whether slides are in fullscreen
      currentSlideId: string | null, // Current slide ID
    },
    currentSlideIndex: number, // Current slide index
  }),

  applySlideState: (slideState, currentSlideIndex) => {
    // Apply slide state during playback
    // Update your slide components to match the recorded state
  },

  getSlides: () => [
    // Array of slide objects
    { id: "slide1", imageUrl: "https://...", order: 0 },
    { id: "slide2", imageUrl: "https://...", order: 1 },
  ],

  applySlides: (slides) => {
    // Restore slides data when loading a recording
    // Set your slides array to the provided data
  },

  // Handle slide events during recording
  onSlideEvent: (event) => {
    // Optional: Handle slide events for custom logic
    console.log("Slide event:", event);
  },
});
```

### Slide Events

During recording, slide interactions are captured as events:

```typescript
interface SlideEvent {
  type:
    | "slide_open"
    | "slide_close"
    | "slide_change"
    | "slide_maximize"
    | "slide_minimize";
  timestamp: number;
  slideId?: string;
  isMaximized?: boolean;
}
```

Use `handleSlideEvent` to record slide interactions:

```typescript
// When user opens slides
handleSlideEvent({
  type: "slide_open",
  timestamp: performance.now(),
  slideId: currentSlide.id,
});

// When user changes slides
handleSlideEvent({
  type: "slide_change",
  timestamp: performance.now(),
  slideId: newSlide.id,
});

// When user maximizes slides
handleSlideEvent({
  type: "slide_maximize",
  timestamp: performance.now(),
  slideId: currentSlide.id,
  isMaximized: true,
});
```

### Recording Data Structure

Slide data is efficiently stored in recordings:

```typescript
interface Recording {
  id: string;
  name: string;
  snapshots: EditorSnapshot[]; // Code and slide state changes
  slideEvents?: SlideEvent[]; // Slide interaction events
  slides?: Array<{ // Slide data (stored once per recording)
    id: string;
    imageUrl: string;
    name?: string;
    order: number;
  }>;
  audioBlob?: Blob;
  duration: number;
  createdAt: number;
}
```

### Best Practices

1. **Efficient Storage**: Slide data is stored once per recording, while only
   slide state changes are captured in snapshots
2. **State Synchronization**: Slide state is automatically synchronized during
   playback
3. **User Interaction**: Slide navigation is automatically disabled during
   playback to prevent desynchronization
4. **Event Recording**: All slide interactions (open/close, maximize/minimize,
   navigation) are recorded and replayed

## Key Benefits

### ✅ Rearchitected Solution

- Audio recording moved into use-next-editor package
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

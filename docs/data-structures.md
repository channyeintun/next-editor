# Data Structures Documentation

This document describes the core data structures used in the Next Editor application.

---

## Overview

```mermaid
classDiagram
    class Recording {
        +version: 2|3
        +id: string
        +name: string
        +frames: DeltaFrame[]
        +keyframeInterval: number
        +slideEvents?: SlideEvent[]
        +previewEvents?: PreviewEvent[]
        +workspaceEvents?: WorkspaceRecordingEvent[]
        +runtimeEvents?: RuntimeRecordingEvent[]
        +slides?: Slide[]
        +audioBlob?: Blob | AudioPlaceholder
        +workspaceSnapshot?: WorkspaceRecordingSnapshot
        +runtimeSnapshot?: RuntimeRecordingSnapshot
        +duration: number
        +createdAt: number
    }

    class EditorFrame {
        +timestamp: number
        +state: EditorState
    }

    class EditorState {
        +content: string
        +selection: EditorSelection
        +position: EditorPosition
        +viewState: ICodeEditorViewState | null
        +mouseCursor?: MouseCursorPosition
        +slideState?: SlidePreviewState
        +currentSlideIndex?: number
        +previewState?: PreviewState
    }

    class Slide {
        +id: string
        +content: string
        +contentType: SlideContentType
        +name?: string
        +order: number
    }

    class SlidePreviewState {
        +isOpen: boolean
        +isMaximized?: boolean
        +currentSlideId?: string | null
        +indexv?: number
        +currentInteraction?: IframeInteractionEvent
    }

    class PreviewState {
        +size: PreviewSize
        +content?: string
        +scrollTop?: number
        +scrollLeft?: number
        +currentInteraction?: IframeInteractionEvent
    }

    Recording --> EditorFrame : contains
    EditorFrame --> EditorState : has
    Recording --> Slide : contains
    EditorState --> SlidePreviewState : references
    EditorState --> PreviewState : references
```

---

## Core Types

### Recording

The main data structure for storing a recorded session.

```typescript
interface Recording {
  version: 2 | 3;                      // Format version (v3 supports multi-file)
  id: string;                          // Unique identifier
  name: string;                        // Display name
  frames: DeltaFrame[];                // Delta-compressed frames
  keyframeInterval: number;            // Keyframe interval (default: 120)
  
  // Single-file support (v2 & v3)
  slideEvents?: SlideEvent[];          // Slide-related events
  previewEvents?: PreviewEvent[];      // Preview panel events
  slides?: Slide[];                    // Slide content data
  audioBlob?: Blob | AudioPlaceholder; // Audio recording
  
  // Multi-file support (v3 only)
  workspaceEvents?: WorkspaceRecordingEvent[];     // File/folder changes
  runtimeEvents?: RuntimeRecordingEvent[];         // Runtime/terminal events
  workspaceSnapshot?: WorkspaceRecordingSnapshot;  // Workspace state snapshot
  runtimeSnapshot?: RuntimeRecordingSnapshot;      // Runtime state snapshot
  
  // Metadata
  duration: number;                    // Total duration in ms
  createdAt: number;                   // Creation timestamp
}
```

**Version Differences:**
- **v2**: Single editor file recording; ideal for tutorials and code demonstrations
- **v3**: Multi-file workspace recording; captures file changes, workspace state, and runtime/terminal output for full environment replay

### EditorFrame

Represents the complete editor state at a specific timestamp.

```typescript
interface EditorFrame {
  timestamp: number;
  state: {
    content: string;                   // Editor text content
    selection: EditorSelection;        // Text selection
    position: EditorPosition;          // Cursor position
    viewState: ICodeEditorViewState;   // Monaco view state
    mouseCursor?: MouseCursorPosition; // Mouse position
    slideState?: SlidePreviewState;    // Slide preview state
    currentSlideIndex?: number;        // Active slide index
    previewState?: PreviewState;       // Code preview state
  };
}
```

---

## Event Types

### SlideEvent

```mermaid
classDiagram
    class SlideEvent {
        +type: SlideEventType
        +timestamp: number
        +slideId?: string
        +isMaximized?: boolean
        +indexv?: number
        +interaction?: IframeInteractionEvent
    }

    class SlideEventType {
        <<enumeration>>
        slide_open
        slide_close
        slide_change
        slide_maximize
        slide_minimize
        slide_interaction
    }

    SlideEvent --> SlideEventType : has
```

### PreviewEvent

```mermaid
classDiagram
    class PreviewEvent {
        +type: PreviewEventType
        +timestamp: number
        +size?: PreviewSize
        +content?: string
        +scrollTop?: number
        +scrollLeft?: number
        +interaction?: IframeInteractionEvent
    }

    class PreviewEventType {
        <<enumeration>>
        preview_open
        preview_minimize
        preview_maximize
        preview_scroll
        preview_interaction
        preview_refresh
        preview_resize
    }

    PreviewEvent --> PreviewEventType : has
```

---

## Context Types

The application uses three React contexts for state management:

```mermaid
classDiagram
    class NextEditorActions {
        +editorRef: RefObject
        +startRecording(): void
        +stopRecording(): void
        +play(): void
        +pause(): void
        +stop(): void
        +seekTo(time): void
        +loadRecording(recording): void
        +handleEditorChange(): void
        +handleSlideEvent(event): void
        +handlePreviewEvent(event): void
    }

    class NextEditorMetadata {
        +isRecording: boolean
        +isRecordingAudio: boolean
        +isPlaying: boolean
        +isPaused: boolean
        +hasEnded: boolean
        +currentRecording: Recording | null
        +recordingStartTime: number | null
    }

    class NextEditorPlayback {
        +currentTime: number
        +playbackSpeed: number
        +volume: number
        +duration: number
        +currentCursor: MouseCursorPosition | null
    }

    NextEditorActions <-- NextEditorMetadata : stable functions
    NextEditorMetadata <-- NextEditorPlayback : flags & state
```

---

## Storage Types

### JsonStorage Binary Format

```mermaid
flowchart LR
    subgraph Header["Header (10 bytes)"]
        M[Magic: SCRM]
        V[Version: u16]
        L[JSON Length: u32]
    end
    
    subgraph Data
        J[Compressed JSON]
        A[Audio Data]
    end
    
    Header --> Data
```

### AudioPlaceholder

Used for serialization of audio blobs:

```typescript
interface AudioPlaceholder {
  __audio_offset: number;  // Byte offset in binary data
  __audio_size: number;    // Size in bytes
  __audio_type: string;    // MIME type
}
```

---

## Machine Context Types

### EditorMachineContext

The complete state machine context:

```typescript
interface EditorMachineContext {
  timeline: TimelineState;
  session: RecordingSession | null;
  recording: Recording | null;
  currentFrame: EditorFrame | null;
  audio: AudioState;
  editorRefs: EditorRefs;
  enableAudioRecording: boolean;
  pauseOnUserInteraction: boolean;
  animationFrameId: number | null;
  error: string | null;
  lastAppliedFrameIndex: number;
  lastAppliedPreviewEventIndex: number;
  lastAppliedSlideEventIndex: number;
}
```

### TimelineState

```typescript
interface TimelineState {
  currentTime: number;    // Position in ms
  duration: number;       // Total duration in ms
  speed: number;          // Playback multiplier
  volume: number;         // 0.0 - 1.0
  startedAt: number;      // performance.now()
  pausedDuration: number; // Accumulated pause time
  pausedAt: number;       // Pause timestamp
}
```

### RecordingSession

```typescript
interface RecordingSession {
  startedAt: number;                    // Start timestamp
  frames: EditorFrame[];                // Captured frames
  slideEvents: SlideEvent[];            // Slide events
  previewEvents: PreviewEvent[];        // Preview events
  lastMousePosition: MouseCursorPosition;
}
```

# Interactive Coding Platform (Scrimba-like)

## Project Overview
This project is a simplified Scrimba-like interactive coding platform that records Monaco Editor state changes synchronized with audio narration. Using @monaco-editor/react, we capture every keystroke, cursor movement, selection change, and scroll event as timestamped events. The app replays these events in perfect sync with audio, creating an authentic coding tutorial experience. Recordings are stored locally with Redux Toolkit managing all recording and replay states.

## Main Functions

### Record Monaco Editor State Changes
- Captures real-time Monaco Editor events: `onDidChangeContent`, `onDidChangeCursorPosition`, `onDidChangeCursorSelection`, `onDidScrollChange`
- Records timestamped state snapshots for accurate replay
- Simultaneously records audio narration via Web Audio API
- Stores complete editor state at each event for precise seeking

### Media Player-like Replay System
- Replays editor state changes in perfect chronological order
- Synchronizes audio playback with editor state reconstruction
- Supports play, pause, stop, and seek operations
- Instant seeking to any timestamp with accurate editor state restoration

### Future API Compatibility
Designed to support saving recordings to a database and retrieving them for replay via API endpoints.

## How the App Works

1. **Recording Phase**: 
   - User starts recording session with microphone permission
   - Monaco Editor captures every interaction via event listeners:
     - `onDidChangeContent` → Full content snapshots
     - `onDidChangeCursorPosition` → Cursor coordinates  
     - `onDidChangeCursorSelection` → Selection ranges
     - `onDidScrollChange` → Scroll positions
   - Each event gets precise timestamp relative to recording start
   - Audio recording runs in parallel using MediaRecorder API
   - Redux Toolkit stores all events and manages recording state

2. **Replay Phase**:
   - Load recorded session data (events + audio blob)
   - Audio plays while editor state reconstructs chronologically
   - Each timestamped event triggers corresponding Monaco Editor state change
   - Seeking instantly rebuilds editor state up to target timestamp
   - Progress bar shows current position and allows scrubbing

3. **State Management**:
   - Recording slice: manages capture, events array, audio blob
   - Replay slice: handles playback, seeking, editor state reconstruction
   - Local storage persistence for recordings library

## Technology Stack
- React with TypeScript
- Redux Toolkit for state management
- @monaco-editor/react for code editor with event capturing
- Monaco Editor API for direct state manipulation during replay
- MediaRecorder API for audio recording
- Web Audio API for audio playback control
- Local Storage for recordings persistence
- Future: RESTful API for database integration

## Key Components
- `CodeEditor.tsx`: Monaco Editor wrapper with event listeners
- `AudioPlayer.tsx`: Hidden audio element with playback control
- `MediaControls.tsx`: Play/pause/seek interface
- `RecordingList.tsx`: Saved recordings library
- `recordingSlice.ts`: Recording state and event capture
- `replaySlice.ts`: Playback state and editor reconstruction

## Commands
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm test` - Run tests
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript type checking
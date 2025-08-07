# Interactive Coding Platform (Scrimba-like)

## Project Overview
This project is a simplified Scrimba-like interactive coding platform that records Monaco Editor state changes synchronized with audio narration. Using @monaco-editor/react and the custom `use-scrimba` package, we capture every keystroke, cursor movement, selection change, and scroll event as timestamped events. The app replays these events in perfect sync with audio, creating an authentic coding tutorial experience. Recordings are stored locally using the useScrimba hook's built-in state management.

## Main Functions

### Record Monaco Editor State Changes
- Captures real-time Monaco Editor events: `onDidChangeContent`, `onDidChangeCursorPosition`, `onDidChangeCursorSelection`, `onDidScrollChange`
- Records timestamped state snapshots for accurate replay
- Simultaneously records audio narration via MediaRecorder API
- Stores complete editor state at each event for precise seeking
- Audio and code recording managed through the useScrimba hook

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
   - Monaco Editor captures every interaction via the useScrimba hook:
     - `onDidChangeContent` → Full content snapshots
     - `onDidChangeCursorPosition` → Cursor coordinates  
     - `onDidChangeCursorSelection` → Selection ranges
     - `onDidScrollChange` → Scroll positions
   - Each event gets precise timestamp relative to recording start
   - Audio recording runs in parallel using MediaRecorder API
   - useScrimba hook stores all events and manages recording state

2. **Replay Phase**:
   - Load recorded session data (snapshots + audio blob)
   - Audio plays via AudioPlayer component while editor state reconstructs chronologically
   - Each timestamped snapshot triggers corresponding Monaco Editor state change
   - Seeking instantly rebuilds editor state up to target timestamp
   - Progress bar shows current position and allows scrubbing

3. **State Management**:
   - useScrimba hook: manages recording, playback, events, and recordings library
   - React Context: provides useScrimba functionality to all components
   - Local storage persistence through useScrimba's storage interface
   - Audio recording managed in ScrimbaProvider with MediaRecorder API

## Technology Stack
- React with TypeScript
- **use-scrimba package**: Custom React hook for recording/replay functionality
- React Context API for state management across components  
- @monaco-editor/react for code editor with event capturing
- Monaco Editor API for direct state manipulation during replay
- MediaRecorder API for audio recording
- HTML5 Audio API for synchronized audio playback
- Local Storage for recordings persistence
- Future: RESTful API for database integration

## Key Components
- `CodeEditor.tsx`: Monaco Editor wrapper integrated with useScrimba hook
- `AudioPlayer.tsx`: Hidden audio element with synchronized playback control
- `MediaControls.tsx`: Play/pause/seek interface with audio recording indicators
- `RecordingsList.tsx`: Saved recordings library with audio status indicators
- `PlaybackManager.tsx`: Manages synchronized audio + editor playback
- `ScrimbaProvider.tsx`: React Context provider with audio recording integration
- `useScrimbaContext.ts`: Hook to access useScrimba functionality from any component

## Architecture
- **packages/use-scrimba/**: Standalone npm package with core recording/replay logic
- **src/contexts/**: React Context integration for useScrimba package
- **src/components/**: UI components consuming useScrimba via Context
- **src/hooks/**: Custom hooks for accessing ScrimbaContext

## Key Features
- 🎤 **Audio Recording**: Simultaneous microphone capture during coding sessions
- 🎬 **Editor Replay**: Frame-perfect reconstruction of coding sessions
- ⏯️ **Media Controls**: Play, pause, stop, seek with speed control
- 💾 **Local Storage**: Automatic persistence of recordings with audio
- 🔄 **Real-time Sync**: Audio and editor changes perfectly synchronized
- 📱 **Responsive UI**: Clean interface with visual recording indicators

## Package Structure
This project uses a monorepo structure with the core functionality extracted into a reusable package:

### Main Project (`/`)
- React application consuming the use-scrimba package
- Audio recording integration via MediaRecorder API
- React Context for global state management
- UI components and styling

### use-scrimba Package (`/packages/use-scrimba/`)
- Standalone npm package with core recording/replay logic
- Monaco Editor event capture and state management
- Timeline-based playback system with seeking support
- TypeScript types and interfaces
- Examples demonstrating usage patterns

## Commands
- `npm run dev` - Start development server
- `npm run build` - Build for production  
- `npm test` - Run tests
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript type checking

## Package Commands
- `cd packages/use-scrimba && npm run build` - Build the use-scrimba package
- `cd packages/use-scrimba && npm run dev` - Development mode for package
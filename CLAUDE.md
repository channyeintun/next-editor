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
   - **Independent Master Timeline**: Uses `performance.now()` as single source of truth
   - Both audio playback and editor state are synchronized to master timeline
   - **Perfect Synchronization**: Audio and editor updates happen in same `requestAnimationFrame`
   - Direct Monaco Editor manipulation eliminates React re-render delays
   - Seeking instantly rebuilds editor state and resets master timeline
   - Progress bar shows current position and allows scrubbing

3. **State Management**:
   - useScrimba hook: manages recording, playbook, events, and recordings library
   - **Master Timeline Architecture**: Independent `performance.now()` based timing
   - Audio and editor are slaves to master timeline (no circular dependencies)
   - React Context: provides useScrimba functionality to all components
   - Local storage persistence through optimized binary format
   - Audio recording managed in ScrimbaProvider with MediaRecorder API

4. **Storage Format**:
   - **Binary Format (.scrimba)**: Optimized file format with 25-30% space savings
   - **Audio Separation**: Raw binary audio data stored separately from JSON metadata
   - **Compression**: JSON metadata compressed with pako deflate algorithm
   - **Structure**: Header + Compressed JSON + Raw Audio Data
   - **Efficiency**: Zero encoding overhead on audio data (no base64)

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
- `AudioPlayer.tsx`: Hidden audio element managed by master timeline
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
- 💾 **Optimized Storage**: Binary format with 25-30% space savings
- 🔄 **Perfect Sync**: Millisecond-precise audio/editor synchronization via independent master timeline
- 📱 **Responsive UI**: Clean interface with visual recording indicators
- 📦 **Efficient Export**: .scrimba files with zero audio encoding overhead

## Synchronization Architecture

### Master Timeline Design
The core innovation of this platform is the **Independent Master Timeline** that eliminates circular dependencies between audio and editor state:

```
performance.now() Master Timeline
    ├─ Audio Element (slave)
    └─ Editor State (slave)
```

### Key Architectural Benefits:
- **Zero Latency**: Audio and editor updates happen in same `requestAnimationFrame`
- **Perfect Seeking**: Timeline resets maintain sync during scrubbing operations  
- **No Drift**: High-precision `performance.now()` prevents timing accumulation errors
- **Clean Audio Handling**: Proper pause/stop prevents audio artifacts at playback end
- **Direct Monaco Manipulation**: Bypasses React re-render delays for instant editor updates

### Implementation Flow:
1. Master timeline calculates current time from `performance.now()`
2. Audio element position synced to master time
3. Editor state applied directly to Monaco Editor synchronously
4. Redux state updated for UI components
5. All operations complete in single execution frame

## Storage Format (.scrimba)

### Binary Format Structure
The application uses an optimized binary format that separates audio data from JSON metadata for maximum efficiency:

```
[Header: 8 bytes]
├─ Magic: "SCRM" (4 bytes) - File format identifier
├─ Version: 1 (2 bytes) - Format version for future compatibility  
├─ JSON Length: N (2 bytes) - Size of compressed JSON data

[Compressed JSON: N bytes]
├─ Recording metadata (snapshots, timestamps, settings)
├─ Audio placeholders with offset/size information
├─ Compressed using pako deflate (level 9)

[Raw Audio Data: remaining bytes]  
├─ Concatenated binary audio data (WebM/Opus format)
├─ Zero encoding overhead (no base64 conversion)
├─ Direct blob reconstruction during import
```

### Storage Optimization Benefits
- **25-30% Space Savings**: Eliminates base64 encoding overhead on audio data
- **Faster Processing**: Direct binary operations instead of string encoding/decoding  
- **Memory Efficient**: No intermediate base64 conversions during save/load operations
- **Future Proof**: Versioned header supports format evolution

### Audio Placeholder System
Instead of storing large audio blobs in JSON, the format uses lightweight placeholders:
```typescript
{
  __audio_offset: 1234,    // Byte offset in audio section
  __audio_size: 5678,      // Size of audio data in bytes  
  __audio_type: "audio/webm" // MIME type for blob reconstruction
}
```

### Compression Statistics
The UI displays real-time compression statistics comparing the current efficient format against the theoretical size of a traditional JSON+base64 approach, showing the actual space savings achieved.

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
- **Independent Master Timeline**: `performance.now()` based synchronization
- **Native Audio Sync**: Built-in audioRef support for perfect timing
- Direct Monaco manipulation for zero-latency editor updates
- Timeline-based playback system with robust seeking support
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
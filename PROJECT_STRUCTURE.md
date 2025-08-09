# Project Structure

## Overview

This document provides a comprehensive overview of the Interactive Coding Platform project structure, including the main React application and the **use-scrimba** package.

## Root Structure

```
coding-school/
├── src/                          # Main React application
├── packages/use-scrimba/         # Core package (npm publishable)
├── public/                       # Static assets
├── docs/                         # Documentation
├── dist/                         # Build output
├── node_modules/                 # Dependencies
├── package.json                  # Main project config
├── tsconfig.json                 # TypeScript config
├── tsconfig.app.json             # App-specific TS config
├── tsconfig.node.json            # Node-specific TS config
├── vite.config.ts                # Vite configuration
├── eslint.config.js              # ESLint configuration
├── postcss.config.js             # PostCSS configuration
├── index.html                    # HTML entry point
├── CLAUDE.md                     # Project instructions
├── README.md                     # Project documentation
├── ARCHITECTURE.md               # Architecture documentation
└── PROJECT_STRUCTURE.md          # This file
```

## Main Application (`/src`)

### Directory Structure

```
src/
├── components/                   # React UI components
│   ├── CodeEditor.tsx           # Monaco Editor wrapper with use-scrimba integration
│   ├── AudioPlayer.tsx          # Hidden audio element for synchronized playback
│   ├── MediaControls.tsx        # Play/pause/record/seek controls with progress bar
│   └── RecordingsList.tsx       # Library interface for saved recordings
├── contexts/                    # React Context providers and types
│   ├── ScrimbaContext.tsx       # Main context provider with use-scrimba integration
│   └── ScrimbaContext.ts        # Context types and interfaces
├── hooks/                       # Custom React hooks
│   ├── useScrimbaContext.ts     # Hook to access ScrimbaContext safely
│   └── useAudioRecording.ts     # MediaRecorder API integration for audio capture
├── storage/                     # Local storage management
│   ├── JsonStorage.ts           # LocalStorage adapter with SuperJSON serialization
│   └── SuperJsonConfig.ts       # SuperJSON configuration for complex object serialization
├── App.tsx                      # Main application component
├── App.css                      # Application-specific styles
├── main.tsx                     # React application entry point
├── index.css                    # Global styles
└── vite-env.d.ts               # Vite environment type declarations
```

### Component Details

#### `/src/components/CodeEditor.tsx`
- **Purpose**: Monaco Editor integration with use-scrimba hook
- **Key Features**:
  - Monaco Editor setup with TypeScript support
  - Event handling for recording (`handleEditorChange`)
  - Editor mounting integration (`handleEditorMount`)
  - Theme and language configuration
- **Dependencies**: `@monaco-editor/react`, `useScrimbaContext`

#### `/src/components/AudioPlayer.tsx`
- **Purpose**: Hidden audio element for synchronized playback
- **Key Features**:
  - HTML5 audio element management
  - Audio synchronization with master timeline
  - Preload and playback control
- **Dependencies**: `useScrimbaContext`

#### `/src/components/MediaControls.tsx`
- **Purpose**: User interface for recording and playback controls
- **Key Features**:
  - Record/stop recording buttons with visual indicators
  - Play/pause/stop playback controls
  - Seek bar for timeline navigation
  - Playback speed control
  - Real-time progress display
- **Dependencies**: `useScrimbaContext`

#### `/src/components/RecordingsList.tsx`
- **Purpose**: Library management for saved recordings
- **Key Features**:
  - Display list of saved recordings with metadata
  - Load recording for playback
  - Delete recordings
  - Recording duration and creation date display
- **Dependencies**: `useScrimbaContext`

### Context and State Management

#### `/src/contexts/ScrimbaContext.tsx`
- **Purpose**: React Context provider for use-scrimba integration
- **Key Features**:
  - useScrimba hook instantiation with configuration
  - Audio recording integration via MediaRecorder API
  - Storage management for persistence
  - Global state sharing across components
- **Provides**: Complete use-scrimba API surface

#### `/src/contexts/ScrimbaContext.ts`
- **Purpose**: TypeScript definitions for context
- **Exports**: Context types, interfaces, and provider props

### Custom Hooks

#### `/src/hooks/useScrimbaContext.ts`
- **Purpose**: Safe access to ScrimbaContext with error handling
- **Returns**: use-scrimba hook return value
- **Error Handling**: Throws error if used outside provider

#### `/src/hooks/useAudioRecording.ts`
- **Purpose**: MediaRecorder API integration for audio capture
- **Key Features**:
  - Microphone permission handling
  - Audio stream capture
  - Recording lifecycle management
  - Audio blob creation
- **Integration**: Works with use-scrimba's `stopRecording({ audioBlob })`

### Storage Layer

#### `/src/storage/JsonStorage.ts`
- **Purpose**: LocalStorage adapter for recording persistence
- **Key Features**:
  - SuperJSON serialization for complex objects
  - Audio Blob to base64 conversion for storage
  - CRUD operations for recordings
  - Type-safe interfaces
- **Methods**: `save()`, `load()`, `delete()`

#### `/src/storage/SuperJsonConfig.ts`
- **Purpose**: SuperJSON configuration for serialization
- **Handles**: Complex objects, Blobs, Dates, Maps, Sets
- **Usage**: Automatic serialization/deserialization in JsonStorage

## use-scrimba Package (`/packages/use-scrimba`)

### Package Structure

```
packages/use-scrimba/
├── src/                         # Source code
│   ├── hooks/                   # Internal specialized hooks
│   │   ├── useRecording.ts      # Recording logic and event capture
│   │   └── usePlayback.ts       # Playback logic and state application
│   ├── store/                   # Redux Toolkit store
│   │   ├── index.ts             # Store creation and configuration
│   │   ├── recordingSlice.ts    # Recording state management
│   │   └── playbackSlice.ts     # Playback state management
│   ├── utils/                   # Utility functions
│   │   ├── validation.ts        # Input validation and type guards
│   │   └── editorDiff.ts        # Monaco Editor content diffing algorithms
│   ├── useScrimba.ts            # Main hook implementation
│   ├── types.ts                 # TypeScript type definitions
│   ├── index.ts                 # Package exports
│   └── setupTests.ts            # Jest test configuration
├── examples/                    # Usage examples
│   ├── basic/                   # Basic implementation example
│   │   └── BasicExample.tsx
│   ├── with-audio/              # Audio synchronization example
│   │   └── AudioExample.tsx
│   └── perfect-sync/            # Advanced timeline synchronization
│       └── PerfectSyncExample.tsx
├── dist/                        # Built package output
├── scripts/                     # Build and test scripts
│   └── test-simple.sh          # Simple test script
├── package.json                 # Package configuration
├── tsconfig.json                # TypeScript configuration
├── rollup.config.js             # Rollup build configuration
├── jest.config.js               # Jest test configuration
├── publish.sh                   # NPM publishing script
├── README.md                    # Package documentation
├── API.md                       # Detailed API reference
├── ARCHITECTURE.md              # Package architecture documentation
├── PROJECT_STRUCTURE.md         # Package structure documentation
├── TESTING.md                   # Testing guidelines
├── PUBLISHING.md                # Publishing guidelines
└── LICENSE                      # MIT license
```

### Core Implementation Files

#### `/packages/use-scrimba/src/useScrimba.ts`
- **Purpose**: Main hook implementation
- **Key Features**:
  - Redux store integration
  - Monaco Editor event handling
  - Master timeline synchronization
  - Audio synchronization with `performance.now()`
  - Recording and playback lifecycle management
- **Returns**: Complete API surface for recording/playback functionality

#### `/packages/use-scrimba/src/types.ts`
- **Purpose**: TypeScript definitions for the entire package
- **Key Types**:
  - `UseScrimbaConfig`: Hook configuration interface
  - `UseScrimbaReturn`: Hook return type
  - `Recording`: Complete recording with metadata
  - `EditorSnapshot`: Timestamped editor state capture
  - `EditorState`: Current editor state for manipulation
  - `CaptureEvents`: Event capture configuration
  - `ScrimbaAction`: Redux action types

#### `/packages/use-scrimba/src/index.ts`
- **Purpose**: Package entry point and exports
- **Exports**:
  - Main `useScrimba` hook
  - All TypeScript types
  - Internal hooks for advanced usage

### Internal Hooks

#### `/packages/use-scrimba/src/hooks/useRecording.ts`
- **Purpose**: Recording-specific logic extraction
- **Responsibilities**:
  - Monaco Editor event listener setup
  - Event capture filtering based on configuration
  - Snapshot creation and timestamping
  - Recording state validation
- **Integration**: Used internally by main useScrimba hook

#### `/packages/use-scrimba/src/hooks/usePlayback.ts`
- **Purpose**: Playback-specific logic extraction
- **Responsibilities**:
  - Editor state application
  - User interaction pause handling
  - State validation and error recovery
  - Monaco Editor manipulation
- **Integration**: Used internally by main useScrimba hook

### Redux Store Architecture

#### `/packages/use-scrimba/src/store/index.ts`
- **Purpose**: Redux store configuration and creation
- **Features**:
  - Redux Toolkit store setup
  - Combined reducers
  - Store type definitions
  - Action and selector exports

#### `/packages/use-scrimba/src/store/recordingSlice.ts`
- **Purpose**: Recording state management
- **State**:
  - `isRecording`: Recording status
  - `recordingStartTime`: Start timestamp
  - `currentRecording`: Current recording data
- **Actions**: `startRecording`, `stopRecording`, `addSnapshot`, `clearCurrentRecording`

#### `/packages/use-scrimba/src/store/playbackSlice.ts`
- **Purpose**: Playback state management
- **State**:
  - `isPlaying`, `isPaused`, `hasEnded`: Playback status
  - `currentTime`: Current playback position
  - `playbackSpeed`: Speed multiplier
  - `loadedRecording`: Currently loaded recording
  - `currentSnapshot`: Current editor snapshot
  - `editorState`: Current editor state
- **Actions**: `play`, `pause`, `stop`, `end`, `seekTo`, `loadRecording`, `updateCurrentTime`

### Utility Functions

#### `/packages/use-scrimba/src/utils/validation.ts`
- **Purpose**: Input validation and type guards
- **Functions**:
  - `isValidSnapshotState()`: Validates editor snapshot state
  - `isEditorReady()`: Checks if Monaco Editor is ready
  - Input sanitization and bounds checking

#### `/packages/use-scrimba/src/utils/editorDiff.ts`
- **Purpose**: Monaco Editor content diffing algorithms
- **Functions**:
  - `applyContentDiff()`: Efficient content application with minimal disruption
  - Content comparison and optimization
  - Cursor position preservation during updates

### Examples Directory

#### `/packages/use-scrimba/examples/basic/BasicExample.tsx`
- **Purpose**: Minimal implementation example
- **Demonstrates**:
  - Basic hook setup
  - Simple recording/playback
  - Monaco Editor integration

#### `/packages/use-scrimba/examples/with-audio/AudioExample.tsx`
- **Purpose**: Audio synchronization example
- **Demonstrates**:
  - Audio recording integration
  - Synchronized playback
  - Audio element setup

#### `/packages/use-scrimba/examples/perfect-sync/PerfectSyncExample.tsx`
- **Purpose**: Advanced synchronization example
- **Demonstrates**:
  - Master timeline implementation
  - High-precision synchronization
  - Performance optimization techniques

## Configuration Files

### TypeScript Configuration

- **`tsconfig.json`**: Base TypeScript configuration
- **`tsconfig.app.json`**: Application-specific settings
- **`tsconfig.node.json`**: Node.js-specific settings (for build tools)

### Build Configuration

- **`vite.config.ts`**: Vite development and build configuration
- **`rollup.config.js`**: Package build configuration for use-scrimba
- **`eslint.config.js`**: Code linting rules
- **`postcss.config.js`**: CSS processing configuration

### Package Configuration

- **`package.json` (root)**: Main project dependencies and scripts
- **`package.json` (use-scrimba)**: Package-specific configuration for NPM publishing

## Data Flow Overview

### Recording Flow
```
User Action → UI Component → Context → useScrimba Hook
→ Redux Store → Monaco Events → Snapshot Capture → Storage
```

### Playback Flow
```
User Action → UI Component → Context → useScrimba Hook
→ Master Timeline → Audio Sync + Editor Update → UI Feedback
```

### Storage Flow
```
Recording Complete → JsonStorage → SuperJSON Serialization
→ LocalStorage → Base64 Audio Conversion → Persistence
```

## Development Workflow

### Local Development
1. **Main App**: `npm run dev` - Start Vite development server
2. **Package**: `cd packages/use-scrimba && npm run dev` - Package development mode
3. **Testing**: `npm run test` - Run package tests
4. **Linting**: `npm run lint` - Code quality checks

### Build Process
1. **Package Build**: `cd packages/use-scrimba && npm run build` - Build package
2. **App Build**: `npm run build` - Build main application
3. **Type Checking**: `npm run typecheck` - Validate TypeScript

### Package Publishing
1. **Version Bump**: Update version in `packages/use-scrimba/package.json`
2. **Build**: `npm run build`
3. **Test**: `npm run test`
4. **Publish**: `npm run publish` - Runs publish.sh script

## Dependencies Overview

### Main Application Dependencies
- **@monaco-editor/react**: Monaco Editor React wrapper
- **react**, **react-dom**: React framework
- **use-scrimba**: Local package (../../packages/use-scrimba)
- **superjson**: Complex object serialization

### use-scrimba Package Dependencies
- **@reduxjs/toolkit**: State management
- **monaco-editor**: Editor API types and utilities

### Development Dependencies
- **TypeScript**: Type checking and compilation
- **Vite**: Development server and build tool
- **ESLint**: Code linting
- **Jest**: Testing framework
- **Rollup**: Package bundling

This structure provides a clear separation of concerns between the main application (UI and integration) and the reusable package (core functionality), while maintaining strong TypeScript support and comprehensive testing capabilities.
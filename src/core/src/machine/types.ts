import type * as monaco from 'monaco-editor';
import type { SlideEvent, SlidePreviewState, PreviewEvent, PreviewState } from '../slides';
import type { MouseCursorPosition, EditorFrame, Recording } from '../types';

// ============================================================================
// Machine Status Types
// ============================================================================

/**
 * All possible states the editor machine can be in
 */
export type EditorMachineStatus =
    | 'idle'
    | 'recording'
    | 'loading'
    | 'playback'
    | 'playback.ready'
    | 'playback.playing'
    | 'playback.paused'
    | 'playback.ended'
    | 'stoppingRecording';

// ============================================================================
// Machine Context
// ============================================================================

/**
 * Timeline state for playback synchronization
 */
export interface TimelineState {
    /** Current playback position in milliseconds */
    currentTime: number;
    /** Total duration in milliseconds */
    duration: number;
    /** Playback speed multiplier (1.0 = normal) */
    speed: number;
    /** Volume level (0.0 - 1.0) */
    volume: number;
    /** Time when playback started (performance.now()) */
    startedAt: number;
    /** Accumulated paused duration in milliseconds */
    pausedDuration: number;
    /** Time when paused (performance.now()), 0 if not paused */
    pausedAt: number;
}

/**
 * Recording session state
 */
export interface RecordingSession {
    /** When recording started (performance.now()) */
    startedAt: number;
    /** Current active file path */
    activeFile: string;
    /** Current files and their content */
    files: Record<string, string>;
    /** Collected frames during recording */
    frames: EditorFrame[];
    /** Collected slide events during recording */
    slideEvents: SlideEvent[];
    /** Collected preview events during recording */
    previewEvents: PreviewEvent[];
    /** Last known mouse position */
    lastMousePosition: MouseCursorPosition;
}

/**
 * Audio state for recording and playback
 */
export interface AudioState {
    /** Audio blob from recording */
    blob: Blob | null;
    /** Audio element for playback */
    element: HTMLAudioElement | null;
    /** Whether audio recording is active */
    isRecording: boolean;
    /** MediaRecorder instance */
    mediaRecorder: MediaRecorder | null;
    /** Accumulated audio chunks */
    chunks: Blob[];
    /** Detected MIME type */
    mimeType: string;
}

/**
 * Editor references and decorations
 */
export interface EditorRefs {
    /** Monaco editor instance */
    editor: monaco.editor.IStandaloneCodeEditor | null;
    /** Current cursor decorations */
    cursorDecorations: string[];
}

/**
 * Complete machine context
 */
export interface EditorMachineContext {
    /** Timeline state for playback */
    timeline: TimelineState;
    /** Current recording session (during recording) */
    session: RecordingSession | null;
    /** Loaded recording data */
    recording: Recording | null;
    /** Current frame being displayed */
    currentFrame: EditorFrame | null;
    /** Audio state */
    audio: AudioState;
    /** Editor references */
    editorRefs: EditorRefs;
    /** Whether audio recording is enabled */
    enableAudioRecording: boolean;
    /** Whether to pause on user interaction */
    pauseOnUserInteraction: boolean;
    /** Animation frame ID for playback loop */
    animationFrameId: number | null;
    /** Error message if any */
    error: string | null;
    /** Callback to apply slide state during playback */
    applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
    /** Callback to apply slides data during playback */
    applySlides?: (slides: Array<{ id: string; imageUrl: string; name?: string; order: number }>) => void;
    /** Callback to apply preview state during playback */
    applyPreviewState?: (previewState: PreviewState) => void;
    /** Callback to get slide state during recording */
    getSlideState?: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null;
    /** Callback to get slides data during recording */
    getSlides?: () => Array<{ id: string; imageUrl: string; name?: string; order: number }>;
    /** Callback to get preview state during recording */
    getPreviewState?: () => PreviewState | null;
    /** Index of the last applied frame during playback */
    lastAppliedFrameIndex: number;
    /** Index of the last applied preview event during playback */
    lastAppliedPreviewEventIndex: number;
    /** Index of the last applied slide event during playback */
    lastAppliedSlideEventIndex: number;
    /** Last applied preview state to avoid redundant updates */
    lastAppliedPreviewState?: PreviewState;
    /** Last time (performance.now()) audio was synced */
    lastSyncTime?: number;
    /** Current active file path */
    activeFile: string;
    /** Current files and their content */
    files: Record<string, string>;
}

// ============================================================================
// Machine Events
// ============================================================================

/** Start recording event */
export type StartRecordingEvent = { type: 'START_RECORDING' };

/** Stop recording event */
export type StopRecordingEvent = { type: 'STOP_RECORDING' };

/** Capture a frame during recording */
export type CaptureFrameEvent = {
    type: 'CAPTURE_FRAME';
    isMouseMovement?: boolean;
    mousePosition?: { x: number; y: number; visible: boolean };
};

/** Load a recording for playback */
export type LoadRecordingEvent = {
    type: 'LOAD_RECORDING';
    recording: Recording;
};

/** Recording loaded successfully */
export type RecordingLoadedEvent = {
    type: 'RECORDING_LOADED';
    recording: Recording;
    duration: number;
};

/** Recording load failed */
export type LoadFailedEvent = {
    type: 'LOAD_FAILED';
    error: string;
};

/** Generic error event */
export type ErrorEvent = {
    type: 'ERROR';
    error: string;
};

/** Unload current recording */
export type UnloadEvent = { type: 'UNLOAD' };

/** Start playback */
export type PlayEvent = { type: 'PLAY' };

/** Pause playback */
export type PauseEvent = { type: 'PAUSE' };

/** Stop playback and reset */
export type StopEvent = { type: 'STOP' };

/** Seek to specific time */
export type SeekEvent = {
    type: 'SEEK';
    time: number;
};

/** Set playback speed */
export type SetSpeedEvent = {
    type: 'SET_SPEED';
    speed: number;
};

/** Set volume */
export type SetVolumeEvent = {
    type: 'SET_VOLUME';
    volume: number;
};

/** Playback tick event (from animation frame) */
export type TickEvent = {
    type: 'TICK';
    timestamp: number;
    currentTime: number;
};

/** Playback reached the end */
export type FinishedEvent = { type: 'FINISHED' };

/** Audio actor stopped event */
export type AudioActorStoppedEvent = {
    type: 'STOPPED';
    blob: Blob;
};

/** Audio actor started event */
export type AudioActorStartedEvent = {
    type: 'STARTED';
    mediaRecorder: MediaRecorder;
    mimeType: string;
};

/** User interaction during playback */
export type UserInteractionEvent = { type: 'USER_INTERACTION' };

/** Start signal for actors */
export type StartEvent = { type: 'START' };

/** Stop signal for actors */
export type StopEventSignal = { type: 'STOP' };

/** Update editor reference */
export type SetEditorRefEvent = {
    type: 'SET_EDITOR_REF';
    editor: monaco.editor.IStandaloneCodeEditor | null;
};

/** Slide event occurred */
export type SlideEventOccurred = {
    type: 'SLIDE_EVENT';
    event: SlideEvent;
};

/** Preview event occurred */
export type PreviewEventOccurred = {
    type: 'PREVIEW_EVENT';
    event: PreviewEvent;
};

/** Switch active file */
export type SwitchFileEvent = {
    type: 'SWITCH_FILE';
    activeFile: string;
};

/** Add a new file */
export type AddFileEvent = {
    type: 'ADD_FILE';
    path: string;
    content: string;
};

/** Delete a file */
export type DeleteFileEvent = {
    type: 'DELETE_FILE';
    path: string;
};

/** Rename a file */
export type RenameFileEvent = {
    type: 'RENAME_FILE';
    oldPath: string;
    newPath: string;
};

/** Audio chunk received */
export type AudioChunkEvent = {
    type: 'CHUNK';
    chunk: Blob;
};

/**
 * Union of all machine events
 */
export type EditorMachineEvent =
    | StartRecordingEvent
    | StopRecordingEvent
    | CaptureFrameEvent
    | LoadRecordingEvent
    | RecordingLoadedEvent
    | LoadFailedEvent
    | UnloadEvent
    | PlayEvent
    | PauseEvent
    | StopEvent
    | SeekEvent
    | SetSpeedEvent
    | SetVolumeEvent
    | TickEvent
    | FinishedEvent
    | UserInteractionEvent
    | SetEditorRefEvent
    | SlideEventOccurred
    | PreviewEventOccurred
    | SwitchFileEvent
    | AddFileEvent
    | DeleteFileEvent
    | AudioChunkEvent
    | AudioActorStoppedEvent
    | AudioActorStartedEvent
    | StartEvent
    | StopEventSignal
    | RenameFileEvent
    | ErrorEvent;

// ============================================================================
// Machine Input (Configuration)
// ============================================================================

/**
 * Input provided when creating the machine
 */
export interface EditorMachineInput {
    /** Monaco editor ref */
    editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
    /** Enable audio recording */
    enableAudioRecording?: boolean;
    /** Pause playback on user interaction */
    pauseOnUserInteraction?: boolean;
    /** Default playback speed */
    defaultPlaybackSpeed?: number;
    /** Callbacks */
    onRecordingStart?: () => void;
    onRecordingStop?: (recording: Recording) => void;
    onPlaybackStart?: () => void;
    onPlaybackPause?: () => void;
    onPlaybackEnd?: () => void;
    onSeek?: (time: number) => void;
    onError?: (error: Error) => void;
    onFrame?: (frame: EditorFrame) => void;
    onStateChange?: (state: EditorFrame['state']) => void;
    onPlaybackUpdate?: (currentTime: number, frame: EditorFrame | null) => void;
    onSlideEvent?: (event: SlideEvent) => void;
    getSlideState?: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null;
    applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
    getSlides?: () => Array<{ id: string; imageUrl: string; name?: string; order: number }>;
    applySlides?: (slides: Array<{ id: string; imageUrl: string; name?: string; order: number }>) => void;
    onPreviewEvent?: (event: PreviewEvent) => void;
    getPreviewState?: () => PreviewState | null;
    applyPreviewState?: (previewState: PreviewState) => void;
}

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Initial context factory
 */
export const createInitialContext = (input: EditorMachineInput): EditorMachineContext => ({
    timeline: {
        currentTime: 0,
        duration: 0,
        speed: input.defaultPlaybackSpeed ?? 1,
        volume: 1,
        startedAt: 0,
        pausedDuration: 0,
        pausedAt: 0,
    },
    session: null,
    recording: null,
    currentFrame: null,
    audio: {
        blob: null,
        element: null,
        isRecording: false,
        mediaRecorder: null,
        chunks: [],
        mimeType: '',
    },
    editorRefs: {
        editor: input.editorRef.current,
        cursorDecorations: [],
    },
    enableAudioRecording: input.enableAudioRecording ?? false,
    pauseOnUserInteraction: input.pauseOnUserInteraction ?? true,
    animationFrameId: null,
    error: null,
    lastAppliedFrameIndex: -1,
    lastAppliedPreviewEventIndex: -1,
    lastAppliedSlideEventIndex: -1,
    lastAppliedPreviewState: undefined,
    applySlideState: input.applySlideState,
    applySlides: input.applySlides,
    getSlideState: input.getSlideState,
    getSlides: input.getSlides,
    applyPreviewState: input.applyPreviewState,
    getPreviewState: input.getPreviewState,
    activeFile: 'index.html',
    files: { 'index.html': '<html>\n    <h1>Hello world</h1>\n</html>' },
});

export { useNextEditor } from './useNextEditor';

// Contexts
export { NextEditorProvider } from '../../contexts/NextEditorProvider';
export {
  NextEditorActionsContext,
  NextEditorMetadataContext,
  NextEditorPlaybackContext
} from '../../contexts/NextEditorContext';
export { SlidesProvider } from '../../contexts/SlidesContext';

// Hooks
export {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback
} from '../../hooks/useNextEditorContext';
export { useSlides } from '../../hooks/useSlides';

// Components
export { default as CodeEditor } from '../../components/CodeEditor';
export { default as MediaControls } from '../../components/MediaControls';
export { default as Preview } from '../../components/Preview';
export { default as CursorComponent } from '../../components/Cursor';
export { default as SlidePanel } from '../../components/SlidePanel';
// export { default as NextEditorImageSaveModal } from '../../components/ShareModal';

// Type exports for users
export type {
  MouseCursorPosition,
  EditorFrame,
  Recording,
  UseNextEditorConfig,
  UseNextEditorReturn,
  EditorState,
} from './types';

// Machine exports
export { editorMachine } from './machine/editorMachine';
export type { EditorMachineStatus, EditorMachineContext, EditorMachineEvent } from './machine/types';

// Slide type exports
export type {
  Slide,
  SlidePreviewState,
  SlideEvent,
  PreviewSize,
  PreviewState,
  PreviewEvent,
} from './slides';

// Re-export audio recording hook for advanced users
export { useAudioRecording } from './hooks/useAudioRecording';
export type { UseAudioRecordingReturn } from './hooks/useAudioRecording';

// WASM exports
export { initWasm } from './utils/wasm';
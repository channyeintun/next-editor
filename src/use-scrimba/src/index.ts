export { useScrimba } from './useScrimba';

// Contexts
export { ScrimbaProvider } from '../../contexts/ScrimbaProvider';
export { ScrimbaContext } from '../../contexts/ScrimbaContext';
export { SlidesProvider } from '../../contexts/SlidesContext';

// Hooks
export { useScrimbaContext } from '../../hooks/useScrimbaContext';
export { useSlides } from '../../hooks/useSlides';

// Components
export { default as CodeEditor } from '../../components/CodeEditor';
export { default as MediaControls } from '../../components/MediaControls';
export { default as Preview } from '../../components/Preview';
export { default as CursorComponent } from '../../components/Cursor';
export { default as SlidePanel } from '../../components/SlidePanel';
export { default as ScrimbaImageSaveModal } from '../../components/ScrimbaImageSaveModal';

// Type exports for users
export type {
  MouseCursorPosition,
  EditorSnapshot,
  Recording,
  UseScrimbaConfig,
  UseScrimbaReturn,
  EditorState,
} from './types';

// Slide type exports
export type {
  Slide,
  SlidePreviewState,
  SlideEvent,
} from './slides';

// Re-export audio recording hook for advanced users
export { useAudioRecording } from './hooks/useAudioRecording';
export type { UseAudioRecordingReturn } from './hooks/useAudioRecording';

// Steganography exports
export { decodeDataFromCanvas, MAGIC_PREFIX } from './utils/steganography';
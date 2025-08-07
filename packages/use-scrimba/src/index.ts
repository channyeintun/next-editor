// Main hook export
export { useScrimba } from './useScrimba';

// Type exports for users
export type {
  EditorSnapshot,
  Recording,
  CaptureEvents,
  StorageProvider,
  UseScrimbaConfig,
  UseScrimbaReturn,
  EditorState,
} from './types';

// Re-export internal hooks for advanced users
export { useRecording } from './hooks/useRecording';
export { usePlayback } from './hooks/usePlayback';
// Main hook export
export { useScrimba } from './useScrimba';

// Type exports for users
export type {
  MouseCursorPosition,
  EditorSnapshot,
  Recording,
  UseScrimbaConfig,
  UseScrimbaReturn,
  EditorState,
} from './types';

// Re-export audio recording hook for advanced users
export { useAudioRecording } from './hooks/useAudioRecording';
export type { UseAudioRecordingReturn } from './hooks/useAudioRecording';
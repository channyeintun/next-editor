import { useContext } from 'react';
import {
  NextEditorActionsContext,
  NextEditorMetadataContext,
  NextEditorPlaybackContext,
  type NextEditorActions,
  type NextEditorMetadata,
  type NextEditorPlayback
} from '../contexts/NextEditorContext';

/**
 * Hook to access stable actions, refs, and storage methods.
 * Component using this will NOT re-render on machine ticks.
 */
export const useNextEditorActions = (): NextEditorActions => {
  const context = useContext(NextEditorActionsContext);
  if (!context) {
    throw new Error('useNextEditorActions must be used within a NextEditorProvider');
  }
  return context;
};

/**
 * Hook to access metadata/flags (isRecording, isPlaying, etc.).
 * Component using this will re-render when recording/playback state transitions.
 */
export const useNextEditorMetadata = (): NextEditorMetadata => {
  const context = useContext(NextEditorMetadataContext);
  if (!context) {
    throw new Error('useNextEditorMetadata must be used within a NextEditorProvider');
  }
  return context;
};

/**
 * Hook to access high-frequency playback state (currentTime, volume).
 * Component using this WILL re-render on every machine tick during playback.
 */
export const useNextEditorPlayback = (): NextEditorPlayback => {
  const context = useContext(NextEditorPlaybackContext);
  if (!context) {
    throw new Error('useNextEditorPlayback must be used within a NextEditorProvider');
  }
  return context;
};
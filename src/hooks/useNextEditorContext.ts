import { useContext } from 'react';
import { useSelector, shallowEqual } from '@xstate/react';
import { type SnapshotFrom } from 'xstate';
import { timelineMachine } from '../core/src/machine/timelineMachine';
import { editorMachine } from '../core/src/machine/editorMachine';
import {
  NextEditorActionsContext,
  NextEditorMetadataContext,
  NextEditorPlaybackContext,
  type NextEditorActions,
  type NextEditorMetadata,
  type NextEditorPlayback,
  type TimelineActorRef,
  type EditorActorRef
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
 * Hook to access high-frequency playback state refs (volume, duration).
 * Component using this will NOT re-render on machine ticks.
 */
export const useNextEditorPlayback = (): NextEditorPlayback => {
  const context = useContext(NextEditorPlaybackContext);
  if (!context) {
    throw new Error('useNextEditorPlayback must be used within a NextEditorProvider');
  }
  return context;
};

/**
 * Hook to access live playback time with high frequency.
 * Only the component using this hook will re-render on every tick.
 */
export const useLiveTime = () => {
  const playback = useNextEditorPlayback();
  const timelineActor = playback.timelineActor;
  return useSelector(timelineActor as TimelineActorRef, (state: SnapshotFrom<typeof timelineMachine> | undefined) => state?.context?.currentTime) ?? 0;
};

/**
 * Hook to access live cursor position with high frequency.
 * Only the component using this hook will re-render on cursor movement.
 */
export const useLiveCursor = () => {
  const playback = useNextEditorPlayback();
  const editorActor = playback.editorActor;
  return useSelector(editorActor as EditorActorRef, (state: SnapshotFrom<typeof editorMachine> | undefined) => state?.context?.currentFrame?.state?.mouseCursor || null, shallowEqual);
};
import { useCallback, useEffect } from 'react';
import { useMachine } from '@xstate/react';
import { editorMachine } from './machine/editorMachine';
import type { UseNextEditorConfig, UseNextEditorReturn, EditorState, EditorSnapshot, Recording } from './types';
import type { SlideEvent, PreviewEvent } from './slides';

/**
 * Main useNextEditor hook refactored with XState v5
 * Provides a clean, actor-based architecture for recording and playback.
 */
export const useNextEditor = (config: UseNextEditorConfig): UseNextEditorReturn => {
  // Initialize the machine with input config
  const [state, send] = useMachine(editorMachine, {
    input: config,
  });

  const { context } = state;
  const { editor } = context.editorRefs;

  // Handle editor ref synchronization - run on every render to catch ref changes
  useEffect(() => {
    const currentEditor = config.editorRef.current;
    if (currentEditor && currentEditor !== editor) {
      send({ type: 'SET_EDITOR_REF', editor: currentEditor });
    }
  }); // No dependencies - run on every render to catch ref changes

  // Recording Controls
  const startRecording = useCallback(() => {
    send({ type: 'START_RECORDING' });
  }, [send]);

  const stopRecording = useCallback(() => {
    send({ type: 'STOP_RECORDING' });
  }, [send]);

  // Playback Controls
  const play = useCallback(() => {
    send({ type: 'PLAY' });
  }, [send]);

  const pause = useCallback(() => {
    send({ type: 'PAUSE' });
  }, [send]);

  const stop = useCallback(() => {
    send({ type: 'STOP' });
  }, [send]);

  const seekTo = useCallback((time: number) => {
    send({ type: 'SEEK', time });
  }, [send]);

  const setPlaybackSpeed = useCallback((speed: number) => {
    send({ type: 'SET_SPEED', speed });
  }, [send]);

  const setVolume = useCallback((volume: number) => {
    send({ type: 'SET_VOLUME', volume });
  }, [send]);

  const loadRecording = useCallback((recording: Recording) => {
    send({ type: 'LOAD_RECORDING', recording });
  }, [send]);

  const clearRecording = useCallback(() => {
    send({ type: 'UNLOAD' });
  }, [send]);

  // Event Handlers for UI
  const handleEditorChange = useCallback(() => {
    send({ type: 'CAPTURE_SNAPSHOT' });
  }, [send]);

  const handleSlideEvent = useCallback((event: SlideEvent) => {
    send({ type: 'SLIDE_EVENT', event });
  }, [send]);

  const handlePreviewEvent = useCallback((event: PreviewEvent) => {
    send({ type: 'PREVIEW_EVENT', event });
  }, [send]);

  // Helper functions
  const getEditorState = useCallback((): EditorState | null => {
    if (!editor) return null;
    return {
      content: editor.getValue(),
      selection: editor.getSelection()!,
      position: editor.getPosition()!,
      viewState: editor.saveViewState(),
    };
  }, [editor]);

  const getSnapshot = useCallback((timestamp?: number): EditorSnapshot | null => {
    if (timestamp === undefined) return context.currentSnapshot;
    if (!context.recording) return null;

    // Find closest snapshot at or before timestamp
    const snapshots = context.recording.snapshots;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].timestamp <= timestamp) return snapshots[i];
    }
    return snapshots[0] || null;
  }, [context.currentSnapshot, context.recording]);

  return {
    // State
    isRecording: state.matches('recording'),
    isRecordingAudio: context.audio.isRecording,
    recordingStartTime: context.session?.startedAt || null,

    isPlaying: state.matches({ playback: 'playing' }),
    isPaused: state.matches({ playback: 'paused' }) || (state.matches({ playback: 'ended' }) && context.timeline.currentTime < context.timeline.duration - 100),
    hasEnded: state.matches({ playback: 'ended' }) && context.timeline.currentTime >= context.timeline.duration - 100,

    currentTime: context.timeline.currentTime,
    playbackSpeed: context.timeline.speed,
    volume: context.timeline.volume,

    // Data
    currentRecording: context.recording,
    currentCursor: context.currentSnapshot?.state.mouseCursor || null,
    actualDuration: context.timeline.duration / 1000, // seconds for actualDuration

    // Controls
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    clearRecording,

    // Integration
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,

    // Helpers
    getEditorState,
    getSnapshot,
  };
};
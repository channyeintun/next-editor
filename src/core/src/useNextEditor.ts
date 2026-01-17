import { useCallback, useEffect } from 'react';
import * as monaco from 'monaco-editor';
import { useMachine } from '@xstate/react';
import { editorMachine } from './machine/editorMachine';
import type { UseNextEditorConfig, UseNextEditorReturn, EditorState, EditorFrame, Recording } from './types';
import type { SlideEvent, PreviewEvent } from './slides';
import { findFrameIndexAtTime, reconstructFrameAtIndex } from './utils/frameDelta';

/**
 * Main useNextEditor hook refactored with XState v5
 * Provides a clean, actor-based architecture for recording and playback.
 */
export const useNextEditor = (config: UseNextEditorConfig): UseNextEditorReturn => {
  // Initialize the machine with input config
  const [state, send] = useMachine(editorMachine, {
    input: config,
  });

  type MatchesParam = Parameters<typeof state.matches>[0];

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
    if (state.matches('recording' as MatchesParam)) {
      send({ type: 'CAPTURE_FRAME' });
    }
  }, [send, state]);

  const isPlaying = state.matches({ playback: 'playing' } as MatchesParam);

  // Handle playback interaction detection via direct input listeners
  // This is more stable than onChange for preventing machine/user feedback loops
  useEffect(() => {
    if (isPlaying && editor) {
      const disposables: monaco.IDisposable[] = [];

      // Listen for user keyboard input during replay
      disposables.push(
        editor.onKeyDown((e) => {
          // Ignore navigation/modifier keys to only pause on potential value changes
          const ignoreKeys = [
            monaco.KeyCode.LeftArrow, monaco.KeyCode.RightArrow,
            monaco.KeyCode.UpArrow, monaco.KeyCode.DownArrow,
            monaco.KeyCode.PageUp, monaco.KeyCode.PageDown,
            monaco.KeyCode.Home, monaco.KeyCode.End,
            monaco.KeyCode.Shift, monaco.KeyCode.Ctrl,
            monaco.KeyCode.Alt, monaco.KeyCode.Meta,
            monaco.KeyCode.CapsLock, monaco.KeyCode.Escape,
            monaco.KeyCode.F1, monaco.KeyCode.F2, monaco.KeyCode.F3, monaco.KeyCode.F4,
            monaco.KeyCode.F5, monaco.KeyCode.F6, monaco.KeyCode.F7, monaco.KeyCode.F8,
            monaco.KeyCode.F9, monaco.KeyCode.F10, monaco.KeyCode.F11, monaco.KeyCode.F12
          ];

          if (!ignoreKeys.includes(e.keyCode)) {
            send({ type: 'USER_INTERACTION' });
          }
        })
      );

      // Listen for paste events
      disposables.push(
        editor.onDidPaste(() => {
          send({ type: 'USER_INTERACTION' });
        })
      );

      return () => {
        disposables.forEach(d => d.dispose());
      };
    }
  }, [isPlaying, editor, send]);

  // Global space key listener to pause playback
  useEffect(() => {
    if (isPlaying) {
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        // Only trigger on Space key
        if (e.code === 'Space' || e.key === ' ') {
          e.preventDefault(); // Prevent page scrolling
          send({ type: 'USER_INTERACTION' }); // This triggers PAUSE in the machine
        }
      };

      window.addEventListener('keydown', handleGlobalKeyDown, true); // Use capture phase to catch it early
      return () => {
        window.removeEventListener('keydown', handleGlobalKeyDown, true);
      };
    }
  }, [isPlaying, send]);

  const handleSlideEvent = useCallback((event: SlideEvent) => {
    if (state.matches('recording' as MatchesParam)) {
      send({ type: 'SLIDE_EVENT', event });
    }
  }, [send, state]);

  const handlePreviewEvent = useCallback((event: PreviewEvent) => {
    if (state.matches('recording' as MatchesParam)) {
      send({ type: 'PREVIEW_EVENT', event });
    }
  }, [send, state]);

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

  const getFrame = useCallback((timestamp?: number): EditorFrame | null => {
    if (timestamp === undefined) return context.currentFrame;
    if (!context.recording) return null;

    // Find closest frame at or before timestamp
    const { frames } = context.recording;
    const index = findFrameIndexAtTime(frames, timestamp);
    return reconstructFrameAtIndex(frames, index);
  }, [context.currentFrame, context.recording]);

  return {
    // State
    isRecording: state.matches('recording' as MatchesParam),
    isRecordingAudio: context.audio.isRecording,
    recordingStartTime: context.session?.startedAt || null,

    isPlaying: state.matches({ playback: 'playing' } as MatchesParam),
    isPaused: state.matches({ playback: 'paused' } as MatchesParam) || (state.matches({ playback: 'ended' } as MatchesParam) && context.timeline.currentTime < context.timeline.duration - 100),
    hasEnded: state.matches({ playback: 'ended' } as MatchesParam) && context.timeline.currentTime >= context.timeline.duration - 100,

    currentTime: context.timeline.currentTime,
    playbackSpeed: context.timeline.speed,
    volume: context.timeline.volume,

    // Data
    currentRecording: context.recording,
    currentCursor: context.currentFrame?.state.mouseCursor || null,
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
    getFrame,
  };
};
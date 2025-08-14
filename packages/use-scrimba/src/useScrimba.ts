import { useState, useCallback, useEffect, useRef } from 'react';
import type * as monaco from 'monaco-editor';
import type { 
  UseScrimbaConfig, 
  UseScrimbaReturn, 
  Recording, 
  EditorSnapshot,
  EditorState,
  ScrimbaAction 
} from './types';
import { useRecording } from './hooks/useRecording';
import { usePlayback } from './hooks/usePlayback';
import { isValidSnapshotState, isEditorReady } from './utils/validation';
import { applyContentDiff } from './utils/editorDiff';
import { 
  createScrimbaStore,
  startRecording as startRecordingAction,
  stopRecording as stopRecordingAction,
  addSnapshot,
  clearCurrentRecording,
  play as playAction,
  pause as pauseAction,
  stop as stopAction,
  end,
  updateCurrentTime,
  seekTo as seekToAction,
  setPlaybackSpeed as setPlaybackSpeedAction,
  loadRecording as loadRecordingAction,
  updateCurrentSnapshot,
  updateEditorState,
} from './store';

/**
 * Main useScrimba hook - provides Scrimba-like recording and playback functionality
 * Now powered by Redux Toolkit for better state management
 */
export const useScrimba = (config: UseScrimbaConfig): UseScrimbaReturn => {
  const {
    editorRef,
    audioRef,
    captureEvents = {},
    pauseOnUserInteraction = true,
    onRecordingStart,
    onRecordingStop,
    onPlaybackStart,
    onPlaybackPause,
    onSeek,
    onError,
    // New granular callbacks
    onSnapshot,
    onStateChange,
    onPlaybackUpdate,
  } = config;

  // Create Redux store instance for this hook
  const [store] = useState(() => createScrimbaStore());
  const [, forceUpdate] = useState({});

  // Force component update when store changes
  const triggerUpdate = useCallback(() => {
    forceUpdate({});
  }, []);

  // Subscribe to store changes
  useEffect(() => {
    const unsubscribe = store.subscribe(triggerUpdate);
    return unsubscribe;
  }, [store, triggerUpdate]);

  // Get current state from store
  const state = store.getState();
  const { recording, playback } = state;

  // Playback timeline refs
  const playbackTimerRef = useRef<number | null>(null);
  const playbackStartTimeRef = useRef<number | null>(null);
  const masterTimelineStartRef = useRef<{ perfTime: number; currentTime: number } | null>(null);

  // Callback for handling new snapshots
  const handleSnapshot = useCallback((snapshot: EditorSnapshot) => {
    store.dispatch(addSnapshot(snapshot));
    onSnapshot?.(snapshot);
  }, [store, onSnapshot]);

  // Internal recording hook
  const { handleEditorChange, recordingStartTime } = useRecording(
    editorRef,
    recording.isRecording,
    playback.isPlaying,
    captureEvents,
    handleSnapshot
  );

  // Callback for handling playback pause
  const handlePlaybackPause = useCallback(() => {
    store.dispatch(pauseAction());

    // Pause audio if available
    if (audioRef?.current && playback.loadedRecording?.audioBlob) {
      audioRef.current.pause();
    }
    
    // Clear playback timer
    if (playbackTimerRef.current) {
      cancelAnimationFrame(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    onPlaybackPause?.();
  }, [store, audioRef, playback.loadedRecording?.audioBlob, onPlaybackPause]);

  // Internal playback hook
  const { getEditorState, applyEditorState } = usePlayback(
    editorRef,
    playback.isPlaying,
    playback.editorState,
    pauseOnUserInteraction,
    handlePlaybackPause
  );

  // Recording controls
  const startRecording = useCallback(() => {
    try {
      store.dispatch(startRecordingAction());
      onRecordingStart?.();
    } catch (error) {
      onError?.(error as Error);
    }
  }, [store, onRecordingStart, onError]);

  const stopRecording = useCallback((options?: { audioBlob?: Blob }) => {
    try {
      if (recording.currentRecording && recordingStartTime) {
        store.dispatch(stopRecordingAction({ audioBlob: options?.audioBlob }));
        
        const currentRecordingData = store.getState().recording.currentRecording;
        if (currentRecordingData) {
          const recordingData: Recording = {
            id: Date.now().toString(),
            name: `Recording ${Date.now()}`,
            createdAt: Date.now(),
            snapshots: currentRecordingData.snapshots,
            duration: currentRecordingData.duration,
            audioBlob: currentRecordingData.audioBlob,
          };

          // Just call the callback with the recording data
          // The main project will handle storage
          store.dispatch(clearCurrentRecording());
          
          onRecordingStop?.(recordingData);
        }
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [store, recording.currentRecording, recordingStartTime, onRecordingStop, onError]);

  // Helper function to safely apply editor state
  const applyEditorStateSafely = useCallback((state: EditorState): boolean => {
    try {
      applyEditorState(state);
      return true;
    } catch (error) {
      console.warn('Error applying editor state:', error);
      return false;
    }
  }, [applyEditorState]);

  // Helper function for safe playback cleanup
  const cleanupPlayback = useCallback(() => {
    store.dispatch(pauseAction());
    if (playbackTimerRef.current) {
      cancelAnimationFrame(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  }, [store]);

  // Master timeline synchronization - independent of both audio and editor
  useEffect(() => {
    if (!playback.isPlaying || !playback.loadedRecording) return;
    
    const hasAudio = audioRef?.current && playback.loadedRecording.audioBlob;
    const hasEditor = editorRef?.current && isEditorReady(editorRef.current);
    
    if (hasAudio) {
      // For audio playback, use independent timeline with performance.now()
      const audio = audioRef.current!;
      const editor = editorRef?.current;
      const snapshots = playback.loadedRecording.snapshots;
      
      // Initialize or update master timeline reference
      if (!masterTimelineStartRef.current) {
        masterTimelineStartRef.current = {
          perfTime: performance.now(),
          currentTime: playback.currentTime
        };
      }
      
      const masterTimelineUpdate = () => {
        const currentState = store.getState().playback;
        if (!currentState.isPlaying || !masterTimelineStartRef.current) return;
        
        // MASTER TIMELINE: Use audio's native currentTime as the source of truth
        const audioCurrentTime = audio.currentTime * 1000; // Convert to milliseconds
        const masterTime = audioCurrentTime;
        
        // Update Redux state based on audio timing
        store.dispatch(updateCurrentTime(masterTime));
        
        // Apply editor state changes synchronously
        if (hasEditor && editor) {
          const validSnapshots = snapshots.filter(s => s?.timestamp !== undefined);
          const currentSnapshotToApply = validSnapshots
            .filter(s => s.timestamp <= masterTime)
            .pop();
          
          if (currentSnapshotToApply && 
              currentSnapshotToApply !== store.getState().playback.currentSnapshot && 
              currentSnapshotToApply.state &&
              isValidSnapshotState(currentSnapshotToApply.state)) {
            
            store.dispatch(updateCurrentSnapshot(currentSnapshotToApply));
            const newState = {
              content: currentSnapshotToApply.state.content || '',
              selection: currentSnapshotToApply.state.selection,
              position: currentSnapshotToApply.state.position,
              viewState: currentSnapshotToApply.state.viewState,
              mouseCursor: currentSnapshotToApply.state.mouseCursor,
            };
            store.dispatch(updateEditorState(newState));
            
            // Apply to Monaco directly and synchronously
            try {
              applyContentDiff(editor, newState.content);
              
              if (editor.getValue() === newState.content) {
                const model = editor.getModel();
                if (model) {
                  const lineCount = model.getLineCount();
                  const safeLineNumber = Math.min(Math.max(newState.position.lineNumber, 1), lineCount);
                  const lineLength = model.getLineLength(safeLineNumber);
                  if (lineLength >= 0) {
                    const maxColumn = Math.max(1, lineLength + 1);
                    const validPosition = {
                      lineNumber: safeLineNumber,
                      column: Math.min(Math.max(newState.position.column, 1), maxColumn)
                    };
                    editor.setPosition(validPosition);
                    editor.setSelection(newState.selection);
                    
                    if (newState.viewState) {
                      try {
                        editor.restoreViewState(newState.viewState);
                      } catch {
                        // Ignore view state errors
                      }
                    }
                  }
                }
              }
            } catch (error) {
              console.warn('Editor sync error:', error);
            }
            
            onStateChange?.(newState);
            onPlaybackUpdate?.(masterTime, currentSnapshotToApply);
          }
        }
        
        // Check if playback complete - let audio handle its own ending
        const recordingDuration = currentState.loadedRecording!.duration;
        if (masterTime >= recordingDuration) {
          store.dispatch(end());
          masterTimelineStartRef.current = null;
          return;
        }
        
        // Continue master timeline
        playbackTimerRef.current = requestAnimationFrame(masterTimelineUpdate);
      };
      
      // Start master timeline
      masterTimelineUpdate();
      
      // Handle audio events - only essential ones
      const handleAudioEnded = () => {
        const state = store.getState().playback;
        if (state.isPlaying) {
          store.dispatch(end());
          masterTimelineStartRef.current = null;
          if (playbackTimerRef.current) {
            cancelAnimationFrame(playbackTimerRef.current);
            playbackTimerRef.current = null;
          }
        }
      };
      
      const handleAudioPause = () => {
        // Only handle if we didn't initiate the pause
        const state = store.getState().playback;
        if (state.isPlaying) {
          handlePlaybackPause();
        }
      };
      
      audio.addEventListener('ended', handleAudioEnded);
      audio.addEventListener('pause', handleAudioPause);
      
      return () => {
        audio.removeEventListener('ended', handleAudioEnded);
        audio.removeEventListener('pause', handleAudioPause);
        // Ensure audio is properly paused during cleanup
        audio.pause();
        if (playbackTimerRef.current) {
          cancelAnimationFrame(playbackTimerRef.current);
          playbackTimerRef.current = null;
        }
        masterTimelineStartRef.current = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.isPlaying, playback.loadedRecording, audioRef, editorRef, store, onStateChange, onPlaybackUpdate]);

  // Editor state synchronization for non-audio playback only
  useEffect(() => {
    // Only handle non-audio playback - audio playback is handled synchronously above
    if (!playback.loadedRecording?.snapshots?.length || 
        !playback.isPlaying || 
        (audioRef?.current && playback.loadedRecording?.audioBlob)) {
      return;
    }

    const currentTime = playback.currentTime;
    const validSnapshots = playback.loadedRecording.snapshots.filter(s => s?.timestamp !== undefined);
    const currentSnapshotToApply = validSnapshots
      .filter(s => s.timestamp <= currentTime)
      .pop();
    
    if (currentSnapshotToApply && 
        currentSnapshotToApply !== playback.currentSnapshot && 
        currentSnapshotToApply.state) {
      // Validate snapshot state before applying
      if (isValidSnapshotState(currentSnapshotToApply.state)) {
        store.dispatch(updateCurrentSnapshot(currentSnapshotToApply));
        const newState = {
          content: currentSnapshotToApply.state.content || '',
          selection: currentSnapshotToApply.state.selection,
          position: currentSnapshotToApply.state.position,
          viewState: currentSnapshotToApply.state.viewState,
          mouseCursor: currentSnapshotToApply.state.mouseCursor,
        };
        store.dispatch(updateEditorState(newState));
        onStateChange?.(newState);
        onPlaybackUpdate?.(currentTime, currentSnapshotToApply);
      }
    }
  }, [playback.currentTime, playback.isPlaying, playback.loadedRecording, playback.currentSnapshot, store, onStateChange, onPlaybackUpdate, audioRef]);

  // Playback controls
  const play = useCallback(() => {
    if (!playback.loadedRecording) {
      console.warn('Cannot play: no recording loaded');
      return;
    }
    
    // Allow playback if there's audio even without snapshots
    if (!playback.loadedRecording.snapshots?.length && !playback.loadedRecording.audioBlob) {
      console.warn('Cannot play: no recording content (snapshots or audio) available');
      return;
    }
    
    // If playback has ended, restart from the beginning
    if (playback.hasEnded) {
      store.dispatch(stopAction()); // Reset to beginning
      // Reset master timeline reference for fresh start
      masterTimelineStartRef.current = null;
    }
    
    store.dispatch(playAction());
    // Get fresh state after dispatching actions
    const currentState = store.getState().playback;
    const hasAudio = currentState.loadedRecording?.audioBlob && audioRef?.current;
    
    if (hasAudio) {
      // Ensure audio is properly paused before starting new playback
      audioRef!.current!.pause();
      
      // Set audio position and playback rate, then let it play naturally
      audioRef!.current!.currentTime = currentState.currentTime / 1000;
      audioRef!.current!.playbackRate = currentState.playbackSpeed;
      audioRef!.current!.play().catch(console.error);
      onPlaybackStart?.();
      // Audio will now control its own timing, master timeline will follow
    } else {
      // Non-audio playback - use requestAnimationFrame for smooth timing
      playbackStartTimeRef.current = Date.now() - currentState.currentTime;
      onPlaybackStart?.();

      const updatePlayback = () => {
        const currentState = store.getState().playback;
        
        if (!currentState.loadedRecording || !currentState.isPlaying) {
          return;
        }
        
        if (!playbackStartTimeRef.current) return;
        const elapsed = Date.now() - playbackStartTimeRef.current;
        const adjustedTime = elapsed * currentState.playbackSpeed;
        
        store.dispatch(updateCurrentTime(adjustedTime));
        
        // Check if playback is complete with small buffer to prevent overplay
        if (adjustedTime >= currentState.loadedRecording.duration - 10) {
          store.dispatch(end());
          return;
        }
        
        // Continue non-audio playback
        playbackTimerRef.current = requestAnimationFrame(updatePlayback);
      };
      
      updatePlayback();
    }
  }, [store, playback.loadedRecording, playback.hasEnded, onPlaybackStart, audioRef]);

  const pause = useCallback(() => {
    store.dispatch(pauseAction());
    
    // Pause audio if available
    if (audioRef?.current && playback.loadedRecording?.audioBlob) {
      audioRef.current.pause();
    }
    
    // Clear playback timer (for non-audio playback)
    if (playbackTimerRef.current) {
      cancelAnimationFrame(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    // Keep master timeline reference for resume
  }, [store, audioRef, playback.loadedRecording?.audioBlob]);

  const stop = useCallback(() => {
    store.dispatch(stopAction());
    
    // Stop audio if available
    if (audioRef?.current && playback.loadedRecording?.audioBlob) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    
    // Clear playback timer (for non-audio playback)
    if (playbackTimerRef.current) {
      cancelAnimationFrame(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    // Reset master timeline reference
    masterTimelineStartRef.current = null;
  }, [store, audioRef, playback.loadedRecording?.audioBlob]);

  const seekTo = useCallback((targetTime: number) => {
    if (!playback.loadedRecording) return;
    
    // Input validation - early returns instead of nested logic
    if (typeof targetTime !== 'number' || !isFinite(targetTime) || targetTime < 0) {
      console.warn('Invalid targetTime provided to seekTo:', targetTime);
      return;
    }
    
    if (!playback.loadedRecording.snapshots || playback.loadedRecording.snapshots.length === 0) {
      console.warn('No snapshots available for seeking');
      return;
    }
    
    const clampedTime = Math.min(Math.max(targetTime, 0), playback.loadedRecording.duration);
    
    // ALWAYS pause first to prevent Monaco internal state conflicts
    const wasPlaying = playback.isPlaying;
    if (wasPlaying) {
      store.dispatch(pauseAction());
    }
    
    // Always pause audio during seek regardless of playing state
    if (audioRef?.current && playback.loadedRecording.audioBlob) {
      audioRef.current.pause();
    }
    
    // Clear current playback timer
    if (playbackTimerRef.current) {
      cancelAnimationFrame(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    // Set the seek position in Redux state
    store.dispatch(seekToAction(clampedTime));
    
    // Reset master timeline reference for seek - not needed since audio controls timing
    masterTimelineStartRef.current = null;
    
    // Update audio position if available - this is the only time we set audio currentTime
    if (audioRef?.current && playback.loadedRecording.audioBlob) {
      audioRef.current.currentTime = clampedTime / 1000;
    }
    
    // Find the last snapshot before or at the target time
    let lastSnapshot: EditorSnapshot | null = null;
    for (let i = 0; i < playback.loadedRecording.snapshots.length; i++) {
      const snapshot = playback.loadedRecording.snapshots[i];
      if (snapshot && snapshot.timestamp <= clampedTime) {
        lastSnapshot = snapshot;
      } else {
        break;
      }
    }
    
    // Apply snapshot state or fallback to initial state
    const stateToApply = lastSnapshot?.state ? {
      content: lastSnapshot.state.content || '',
      selection: lastSnapshot.state.selection,
      position: lastSnapshot.state.position,
      viewState: lastSnapshot.state.viewState,
      mouseCursor: lastSnapshot.state.mouseCursor,
    } : {
      content: '',
      selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
      position: { lineNumber: 1, column: 1 } as monaco.Position,
      viewState: null,
      mouseCursor: undefined,
    };
    
    store.dispatch(updateCurrentSnapshot(lastSnapshot));
    store.dispatch(updateEditorState(stateToApply));
    
    // Only apply content during seeking - skip position/selection to avoid Monaco errors
    if (editorRef.current && stateToApply.content !== undefined) {
      const editor = editorRef.current;
      
      // Check if editor is ready before applying state
      if (!isEditorReady(editor)) {
        console.warn('Editor not ready during seek, skipping content application');
        onSeek?.(clampedTime);
        return;
      }
      
      try {
        applyContentDiff(editor, stateToApply.content);
      } catch (error) {
        console.warn('Failed to apply content during seek:', error);
        // Don't call onError for Monaco internal issues - just log and continue
      }
    }
    
    onSeek?.(clampedTime);
    
    // Resume playback after seek
    if (wasPlaying) {
      setTimeout(() => {
        play();
      }, 0);
    }
  }, [store, playback.loadedRecording, playback.isPlaying, onSeek, editorRef, audioRef, play]);

  const setPlaybackSpeed = useCallback((speed: number) => {
    store.dispatch(setPlaybackSpeedAction(speed));
    
    // Update audio playback rate if available
    if (audioRef?.current && playback.loadedRecording?.audioBlob) {
      audioRef.current.playbackRate = speed;
    }
  }, [store, audioRef, playback.loadedRecording?.audioBlob]);

  // Recording management
  const loadRecording = useCallback((recording: Recording) => {
    // Early validation with early returns
    if (!recording) {
      console.warn('Cannot load null/undefined recording');
      return;
    }
    
    if (!recording.snapshots || !Array.isArray(recording.snapshots)) {
      console.warn('Recording has invalid snapshots array');
      return;
    }
    
    if (typeof recording.duration !== 'number' || recording.duration < 0) {
      console.warn('Recording has invalid duration');
      return;
    }
    
    // Clear any existing playback
    cleanupPlayback();
    
    store.dispatch(loadRecordingAction(recording));
    
    // Set up audio if available
    if (audioRef?.current && recording.audioBlob) {
      // Clean up previous blob URL to prevent memory leaks
      if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
        URL.revokeObjectURL(audioRef.current.src);
      }
      
      const audioUrl = URL.createObjectURL(recording.audioBlob);
      audioRef.current.src = audioUrl;
      audioRef.current.currentTime = 0;
      audioRef.current.playbackRate = playback.playbackSpeed;
    }
    
    // Apply initial state - single error boundary
    const initialState = store.getState().playback.editorState;
    if (!applyEditorStateSafely(initialState)) {
      console.warn('Failed to apply initial state when loading recording');
      onError?.(new Error('Failed to apply initial state when loading recording'));
    }
  }, [store, applyEditorStateSafely, cleanupPlayback, onError, audioRef, playback.playbackSpeed]);



  // New granular control APIs
  const getSnapshot = useCallback((timestamp?: number): EditorSnapshot | null => {
    if (!playback.loadedRecording?.snapshots?.length) return null;
    
    if (timestamp === undefined) {
      return playback.currentSnapshot;
    }
    
    // Find snapshot at or before the specified timestamp
    const validSnapshots = playback.loadedRecording.snapshots.filter(s => s?.timestamp !== undefined);
    return validSnapshots
      .filter(s => s.timestamp <= timestamp)
      .pop() || null;
  }, [playback.loadedRecording, playback.currentSnapshot]);

  const getCurrentState = useCallback(() => {
    return store.getState();
  }, [store]);

  const dispatch = useCallback((action: ScrimbaAction) => {
    store.dispatch(action);
  }, [store]);

  const subscribe = useCallback((callback: () => void) => {
    return store.subscribe(callback);
  }, [store]);


  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (playbackTimerRef.current) {
        cancelAnimationFrame(playbackTimerRef.current);
      }
    };
  }, []);

  return {
    // Recording State
    isRecording: recording.isRecording,
    recordingStartTime,
    
    // Playback State
    isPlaying: playback.isPlaying,
    isPaused: playback.isPaused,
    hasEnded: playback.hasEnded,
    currentTime: playback.currentTime,
    playbackSpeed: playback.playbackSpeed,
    
    // Data
    currentRecording: playback.loadedRecording,
    currentCursor: playback.currentSnapshot?.state?.mouseCursor || null,
    
    // Recording Controls
    startRecording,
    stopRecording,
    
    // Playback Controls
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    
    // Recording Management
    loadRecording,
    
    // Monaco Editor Integration
    handleEditorChange,
    
    // Advanced
    getEditorState,
    applyEditorState,
    
    // New granular controls
    getSnapshot,
    getCurrentState,
    dispatch,
    subscribe,
    
  };
};
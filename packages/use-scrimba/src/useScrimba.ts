import { useState, useCallback, useEffect, useRef } from 'react';
import type * as monaco from 'monaco-editor';
import type { 
  UseScrimbaConfig, 
  UseScrimbaReturn, 
  Recording, 
  EditorSnapshot,
  EditorState 
} from './types';
import { useRecording } from './hooks/useRecording';
import { usePlayback } from './hooks/usePlayback';
import { isValidSnapshotState, isEditorReady } from './utils/validation';
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
  addRecording,
  deleteRecording as deleteRecordingAction,
  clearRecordings as clearRecordingsAction,
  setRecordings,
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
    storage,
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
  const { recording, playback, recordings } = state;

  // Playback timeline refs
  const playbackTimerRef = useRef<NodeJS.Timeout | null>(null);
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
    
    // Clear playback timer
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    onPlaybackPause?.();
  }, [store, onPlaybackPause]);

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
            name: `Recording ${recordings.recordings.length + 1}`,
            createdAt: Date.now(),
            snapshots: currentRecordingData.snapshots,
            duration: currentRecordingData.duration,
            audioBlob: currentRecordingData.audioBlob,
          };

          store.dispatch(addRecording(recordingData));
          store.dispatch(clearCurrentRecording());
          
          // Save to storage if provided
          storage?.save?.(recordingData).catch(error => onError?.(error));
          
          onRecordingStop?.(recordingData);
        }
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [store, recording.currentRecording, recordingStartTime, recordings.recordings.length, storage, onRecordingStop, onError]);

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
      if (typeof playbackTimerRef.current === 'number') {
        cancelAnimationFrame(playbackTimerRef.current);
      } else {
        clearTimeout(playbackTimerRef.current);
      }
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
        
        // MASTER TIMELINE: Independent time source using performance.now()
        const elapsed = performance.now() - masterTimelineStartRef.current.perfTime;
        const masterTime = masterTimelineStartRef.current.currentTime + (elapsed * currentState.playbackSpeed);
        
        // Update Redux state
        store.dispatch(updateCurrentTime(masterTime));
        
        // Sync audio to master timeline with bounds checking
        const expectedAudioTime = masterTime / 1000;
        const audioDuration = audio.duration;
        const safeAudioTime = Math.min(expectedAudioTime, audioDuration - 0.01); // Leave 10ms buffer
        
        if (Math.abs(audio.currentTime - safeAudioTime) > 0.1 && safeAudioTime < audioDuration) {
          audio.currentTime = safeAudioTime;
        }
        
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
            };
            store.dispatch(updateEditorState(newState));
            
            // Apply to Monaco directly and synchronously
            try {
              const currentContent = editor.getValue();
              if (currentContent !== newState.content) {
                editor.setValue(newState.content);
              }
              
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
                      } catch (error) {
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
        
        // Check if playback complete with small buffer to prevent overplay
        const recordingDuration = currentState.loadedRecording!.duration;
        if (masterTime >= recordingDuration - 10) { // Stop 10ms before to prevent glitch
          store.dispatch(end());
          // Stop audio cleanly to prevent broken sounds
          audio.pause();
          masterTimelineStartRef.current = null;
          return;
        }
        
        // Continue master timeline
        playbackTimerRef.current = requestAnimationFrame(masterTimelineUpdate) as any;
      };
      
      // Start master timeline
      masterTimelineUpdate();
      
      // Handle audio ended - stop cleanly
      const handleAudioEnded = () => {
        const state = store.getState().playback;
        if (state.isPlaying) {
          store.dispatch(end());
          masterTimelineStartRef.current = null;
        }
      };
      
      audio.addEventListener('ended', handleAudioEnded);
      
      return () => {
        audio.removeEventListener('ended', handleAudioEnded);
        if (playbackTimerRef.current) {
          cancelAnimationFrame(playbackTimerRef.current as unknown as number);
          playbackTimerRef.current = null;
        }
        masterTimelineStartRef.current = null;
      };
    }
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
        };
        store.dispatch(updateEditorState(newState));
        onStateChange?.(newState);
        onPlaybackUpdate?.(currentTime, currentSnapshotToApply);
      }
    }
  }, [playback.currentTime, playback.isPlaying, playback.loadedRecording, playback.currentSnapshot, store, onStateChange, onPlaybackUpdate, audioRef]);

  // Playback controls
  const play = useCallback(() => {
    if (!playback.loadedRecording?.snapshots?.length) {
      console.warn('Cannot play: no recording or snapshots available');
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
      // Start audio playback - master timeline will handle synchronization
      audioRef!.current!.currentTime = currentState.currentTime / 1000;
      audioRef!.current!.playbackRate = currentState.playbackSpeed;
      audioRef!.current!.play().catch(console.error);
      onPlaybackStart?.();
      // Master timeline effect will handle the rest
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
        playbackTimerRef.current = requestAnimationFrame(updatePlayback) as any;
      };
      
      updatePlayback();
    }
  }, [store, playback.loadedRecording, playback.currentTime, playback.playbackSpeed, playback.hasEnded, onPlaybackStart, audioRef]);

  const pause = useCallback(() => {
    store.dispatch(pauseAction());
    
    // Pause audio if available
    if (audioRef?.current && playback.loadedRecording?.audioBlob) {
      audioRef.current.pause();
    }
    
    // Clear playback timer (for non-audio playback)
    if (playbackTimerRef.current) {
      if (typeof playbackTimerRef.current === 'number') {
        cancelAnimationFrame(playbackTimerRef.current);
      } else {
        clearTimeout(playbackTimerRef.current);
      }
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
      if (typeof playbackTimerRef.current === 'number') {
        cancelAnimationFrame(playbackTimerRef.current);
      } else {
        clearTimeout(playbackTimerRef.current);
      }
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
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    // Set the seek position in Redux state
    store.dispatch(seekToAction(clampedTime));
    
    // Reset master timeline reference for seek
    if (masterTimelineStartRef.current) {
      masterTimelineStartRef.current = {
        perfTime: performance.now(),
        currentTime: clampedTime
      };
    }
    
    // Update audio position if available
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
    } : {
      content: '',
      selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
      position: { lineNumber: 1, column: 1 } as monaco.Position,
      viewState: null,
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
        const currentContent = editor.getValue();
        if (currentContent !== stateToApply.content) {
          editor.setValue(stateToApply.content);
        }
      } catch (error) {
        console.warn('Failed to apply content during seek:', error);
        // Don't call onError for Monaco internal issues - just log and continue
      }
    }
    
    onSeek?.(clampedTime);
  }, [store, playback.loadedRecording, onSeek, editorRef, audioRef]);

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

  const deleteRecording = useCallback((id: string) => {
    if (!id || typeof id !== 'string') {
      console.warn('Invalid recording ID provided for deletion:', id);
      return;
    }
    
    store.dispatch(deleteRecordingAction(id));
    
    // Handle storage deletion separately with its own error handling
    if (storage?.delete) {
      storage.delete(id).catch(error => {
        console.warn('Failed to delete recording from storage:', error);
        onError?.(error instanceof Error ? error : new Error('Storage deletion failed'));
      });
    }
  }, [store, storage, onError]);

  const clearRecordings = useCallback(() => {
    store.dispatch(clearRecordingsAction());
  }, [store]);

  // Monaco Editor integration helper
  const handleEditorMount = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (_editor: monaco.editor.IStandaloneCodeEditor) => {
      // User needs to assign editor to their ref manually
      // This function is provided for convenience but doesn't do the assignment
      // Example usage: onMount={(editor) => { editorRef.current = editor; scrimba.handleEditorMount(editor); }}
    },
    []
  );

  // Load recordings from storage on mount
  useEffect(() => {
    if (storage?.load) {
      storage.load()
        .then(loadedRecordings => {
          store.dispatch(setRecordings(loadedRecordings));
        })
        .catch(error => onError?.(error));
    }
  }, [storage, store, onError]);

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

  const dispatch = useCallback((action: any) => {
    store.dispatch(action);
  }, [store]);

  const subscribe = useCallback((callback: () => void) => {
    return store.subscribe(callback);
  }, [store]);

  const loadMultipleRecordings = useCallback((recordings: Recording[]) => {
    store.dispatch(setRecordings(recordings));
  }, [store]);

  const exportRecording = useCallback((id: string, format: 'json' | 'compressed' = 'json'): string | null => {
    const recording = recordings.recordings.find(r => r.id === id);
    if (!recording) {
      console.warn(`Recording with id ${id} not found`);
      return null;
    }

    try {
      if (format === 'json') {
        return JSON.stringify(recording, null, 2);
      } else if (format === 'compressed') {
        // Simple compression: remove whitespace and optional properties
        const compressed = {
          ...recording,
          snapshots: recording.snapshots.map(s => ({
            t: s.timestamp,
            s: {
              c: s.state.content,
              sel: [s.state.selection.startLineNumber, s.state.selection.startColumn, s.state.selection.endLineNumber, s.state.selection.endColumn],
              pos: [s.state.position.lineNumber, s.state.position.column],
              v: s.state.viewState
            }
          }))
        };
        return JSON.stringify(compressed);
      }
    } catch (error) {
      console.error('Error exporting recording:', error);
      onError?.(error instanceof Error ? error : new Error('Export failed'));
    }
    
    return null;
  }, [recordings.recordings, onError]);

  const importRecording = useCallback((data: string, format: 'json' | 'compressed' = 'json'): Recording | null => {
    try {
      const parsed = JSON.parse(data);
      
      if (format === 'compressed') {
        // Decompress the data
        const recording: Recording = {
          ...parsed,
          snapshots: parsed.snapshots.map((s: any) => ({
            timestamp: s.t,
            state: {
              content: s.s.c,
              selection: {
                startLineNumber: s.s.sel[0],
                startColumn: s.s.sel[1],
                endLineNumber: s.s.sel[2],
                endColumn: s.s.sel[3]
              } as monaco.Selection,
              position: {
                lineNumber: s.s.pos[0],
                column: s.s.pos[1]
              } as monaco.Position,
              viewState: s.s.v
            }
          }))
        };
        return recording;
      } else {
        // Validate it's a proper recording
        if (parsed.id && parsed.snapshots && Array.isArray(parsed.snapshots)) {
          return parsed as Recording;
        }
      }
    } catch (error) {
      console.error('Error importing recording:', error);
      onError?.(error instanceof Error ? error : new Error('Import failed'));
    }
    
    return null;
  }, [onError]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
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
    recordings: recordings.recordings,
    currentRecording: playback.loadedRecording,
    currentSnapshot: playback.currentSnapshot,
    
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
    deleteRecording,
    clearRecordings,
    
    // Monaco Editor Integration
    handleEditorMount,
    handleEditorChange,
    
    // Advanced
    getEditorState,
    applyEditorState,
    
    // New granular controls
    getSnapshot,
    getCurrentState,
    dispatch,
    subscribe,
    
    // Batch operations
    loadMultipleRecordings,
    exportRecording,
    importRecording,
  };
};
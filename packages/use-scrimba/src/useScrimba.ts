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

/**
 * Main useScrimba hook - provides Scrimba-like recording and playback functionality
 */
export const useScrimba = (config: UseScrimbaConfig): UseScrimbaReturn => {
  const {
    editorRef,
    captureEvents = {},
    pauseOnUserInteraction = true,
    defaultPlaybackSpeed = 1,
    onRecordingStart,
    onRecordingStop,
    onPlaybackStart,
    onPlaybackPause,
    onSeek,
    onError,
    storage,
  } = config;

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [currentRecording, setCurrentRecording] = useState<{
    snapshots: EditorSnapshot[];
    duration: number;
    audioBlob?: Blob;
  } | null>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasEnded, setHasEnded] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeedState] = useState(defaultPlaybackSpeed);

  // Data state
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loadedRecording, setLoadedRecording] = useState<Recording | null>(null);
  const [currentSnapshot, setCurrentSnapshot] = useState<EditorSnapshot | null>(null);

  // Playback timeline refs
  const playbackTimerRef = useRef<NodeJS.Timeout | null>(null);
  const playbackStartTimeRef = useRef<number | null>(null);

  // Editor state for replay
  const [editorState, setEditorState] = useState<EditorState>({
    content: '',
    selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
    position: { lineNumber: 1, column: 1 } as monaco.Position,
    viewState: null,
  });

  // Callback for handling new snapshots - using functional update to avoid dependency
  const handleSnapshot = useCallback((snapshot: EditorSnapshot) => {
    setCurrentRecording(prev => {
      if (!prev) return null;
      return {
        ...prev,
        snapshots: [...prev.snapshots, snapshot]
      };
    });
  }, []);

  // Internal recording hook
  const { handleEditorChange, recordingStartTime } = useRecording(
    editorRef,
    isRecording,
    isPlaying,
    captureEvents,
    handleSnapshot
  );

  // Callback for handling playback pause - using ref to avoid dependency issues
  const handlePlaybackPause = useCallback(() => {
    setIsPlaying(false);
    setIsPaused(true);
    
    // Clear playback timer
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    onPlaybackPause?.();
  }, [onPlaybackPause]);

  // Internal playback hook
  const { getEditorState, applyEditorState } = usePlayback(
    editorRef,
    isPlaying,
    editorState,
    pauseOnUserInteraction,
    handlePlaybackPause
  );

  // Recording controls
  const startRecording = useCallback(() => {
    try {
      setIsRecording(true);
      setCurrentRecording({
        snapshots: [],
        duration: 0,
      });
      onRecordingStart?.();
    } catch (error) {
      onError?.(error as Error);
    }
  }, [onRecordingStart, onError]);

  const stopRecording = useCallback((options?: { audioBlob?: Blob }) => {
    try {
      if (currentRecording && recordingStartTime) {
        setIsRecording(false);
        
        const recording: Recording = {
          id: Date.now().toString(),
          name: `Recording ${recordings.length + 1}`,
          createdAt: Date.now(),
          snapshots: currentRecording.snapshots,
          duration: Date.now() - recordingStartTime,
          audioBlob: options?.audioBlob || currentRecording.audioBlob,
        };

        setRecordings(prev => [...prev, recording]);
        setCurrentRecording(null);
        
        // Save to storage if provided
        storage?.save?.(recording).catch(error => onError?.(error));
        
        onRecordingStop?.(recording);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [currentRecording, recordingStartTime, recordings.length, storage, onRecordingStop, onError]);

  // Playback controls
  const play = useCallback(() => {
    if (!loadedRecording || !loadedRecording.snapshots || loadedRecording.snapshots.length === 0) {
      console.warn('Cannot play: no recording or snapshots available');
      return;
    }
    
    try {
      setIsPlaying(true);
      setIsPaused(false);
      setHasEnded(false);
      playbackStartTimeRef.current = Date.now() - currentTime;
      
      onPlaybackStart?.();

      // Start the playback timeline
      const updatePlayback = () => {
        if (!playbackStartTimeRef.current || !loadedRecording) return;
        
        try {
          const elapsed = Date.now() - playbackStartTimeRef.current;
          const adjustedTime = elapsed * playbackSpeed;
          
          setCurrentTime(adjustedTime);
          
          // Find current snapshot to apply with null safety
          const validSnapshots = loadedRecording.snapshots.filter(s => s && typeof s.timestamp === 'number');
          const currentSnapshotToApply = validSnapshots
            .filter(s => s.timestamp <= adjustedTime)
            .pop();
          
          if (currentSnapshotToApply && 
              currentSnapshotToApply !== currentSnapshot && 
              currentSnapshotToApply.state) {
            setCurrentSnapshot(currentSnapshotToApply);
            setEditorState({
              content: currentSnapshotToApply.state.content || '',
              selection: currentSnapshotToApply.state.selection,
              position: currentSnapshotToApply.state.position,
              viewState: currentSnapshotToApply.state.viewState,
            });
          }
          
          // Check if playback is complete
          if (adjustedTime >= loadedRecording.duration) {
            setIsPlaying(false);
            setHasEnded(true);
            setCurrentTime(loadedRecording.duration);
            if (playbackTimerRef.current) {
              clearTimeout(playbackTimerRef.current);
              playbackTimerRef.current = null;
            }
            return;
          }
          
          // Continue playback
          playbackTimerRef.current = setTimeout(updatePlayback, 16); // ~60fps
        } catch (error) {
          console.error('Error during playback update:', error);
          setIsPlaying(false);
          if (playbackTimerRef.current) {
            clearTimeout(playbackTimerRef.current);
            playbackTimerRef.current = null;
          }
          onError?.(error instanceof Error ? error : new Error('Playback update failed'));
        }
      };
      
      updatePlayback();
    } catch (error) {
      console.error('Error starting playback:', error);
      onError?.(error instanceof Error ? error : new Error('Failed to start playback'));
    }
  }, [loadedRecording, currentTime, playbackSpeed, currentSnapshot, onPlaybackStart, onError]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    setIsPaused(true);
    
    // Clear playback timer
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    setIsPlaying(false);
    setIsPaused(false);
    setHasEnded(false);
    setCurrentTime(0);
    setCurrentSnapshot(null);
    
    // Clear playback timer
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    // Reset editor state
    setEditorState({
      content: '',
      selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
      position: { lineNumber: 1, column: 1 } as monaco.Position,
      viewState: null,
    });
  }, []);

  const seekTo = useCallback((targetTime: number) => {
    if (!loadedRecording) return;
    
    // Input validation
    if (typeof targetTime !== 'number' || !isFinite(targetTime) || targetTime < 0) {
      console.warn('Invalid targetTime provided to seekTo:', targetTime);
      return;
    }
    
    // Bounds checking
    const clampedTime = Math.min(Math.max(targetTime, 0), loadedRecording.duration);
    
    try {
      // Pause playback when seeking
      if (isPlaying) {
        setIsPlaying(false);
        setIsPaused(true);
      }
      
      // Clear current playback timer
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
      
      setCurrentTime(clampedTime);
      
      // Handle edge case: no snapshots available
      if (!loadedRecording.snapshots || loadedRecording.snapshots.length === 0) {
        console.warn('No snapshots available for seeking');
        onSeek?.(clampedTime);
        return;
      }
      
      // Find the last snapshot before or at the target time
      let lastSnapshot: EditorSnapshot | null = null;
      
      for (let i = 0; i < loadedRecording.snapshots.length; i++) {
        const snapshot = loadedRecording.snapshots[i];
        if (snapshot && snapshot.timestamp <= clampedTime) {
          lastSnapshot = snapshot;
        } else {
          break;
        }
      }
      
      // Apply the snapshot state if found
      if (lastSnapshot && lastSnapshot.state) {
        setCurrentSnapshot(lastSnapshot);
        const newState = {
          content: lastSnapshot.state.content || '',
          selection: lastSnapshot.state.selection,
          position: lastSnapshot.state.position,
          viewState: lastSnapshot.state.viewState,
        };
        setEditorState(newState);
        
        // Apply the state immediately to the editor with error handling
        try {
          applyEditorState(newState);
        } catch (error) {
          console.warn('Error applying editor state during seek:', error);
          onError?.(error instanceof Error ? error : new Error('Failed to apply editor state'));
        }
      } else {
        // Fallback: reset to initial state if no valid snapshot found
        const initialState = {
          content: '',
          selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
          position: { lineNumber: 1, column: 1 } as monaco.Position,
          viewState: null,
        };
        setCurrentSnapshot(null);
        setEditorState(initialState);
        
        try {
          applyEditorState(initialState);
        } catch (error) {
          console.warn('Error applying initial state during seek:', error);
        }
      }
      
      onSeek?.(clampedTime);
    } catch (error) {
      console.error('Error in seekTo:', error);
      onError?.(error instanceof Error ? error : new Error('Seek operation failed'));
    }
  }, [loadedRecording, onSeek, isPlaying, applyEditorState, onError]);

  const setPlaybackSpeed = useCallback((speed: number) => {
    // Input validation for playback speed
    if (typeof speed !== 'number' || !isFinite(speed) || speed <= 0) {
      console.warn('Invalid playback speed provided:', speed);
      return;
    }
    
    // Reasonable bounds for playback speed
    const clampedSpeed = Math.min(Math.max(speed, 0.1), 10);
    if (clampedSpeed !== speed) {
      console.warn(`Playback speed ${speed} clamped to ${clampedSpeed}`);
    }
    
    setPlaybackSpeedState(clampedSpeed);
  }, []);

  // Recording management
  const loadRecording = useCallback((recording: Recording) => {
    if (!recording) {
      console.warn('Cannot load null/undefined recording');
      return;
    }
    
    // Validate recording structure
    if (!recording.snapshots || !Array.isArray(recording.snapshots)) {
      console.warn('Recording has invalid snapshots array');
      return;
    }
    
    if (typeof recording.duration !== 'number' || recording.duration < 0) {
      console.warn('Recording has invalid duration');
      return;
    }
    
    try {
      // Clear any existing playback
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
      
      setLoadedRecording(recording);
      setCurrentTime(0);
      setIsPlaying(false);
      setIsPaused(false);
      setHasEnded(false);
      setCurrentSnapshot(null);
      
      // Reset editor state
      const initialState = {
        content: '',
        selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
        position: { lineNumber: 1, column: 1 } as monaco.Position,
        viewState: null,
      };
      setEditorState(initialState);
      
      // Apply initial state to editor
      try {
        applyEditorState(initialState);
      } catch (error) {
        console.warn('Error applying initial state when loading recording:', error);
      }
    } catch (error) {
      console.error('Error loading recording:', error);
      onError?.(error instanceof Error ? error : new Error('Failed to load recording'));
    }
  }, [applyEditorState, onError]);

  const deleteRecording = useCallback((id: string) => {
    if (!id || typeof id !== 'string') {
      console.warn('Invalid recording ID provided for deletion:', id);
      return;
    }
    
    try {
      setRecordings(prev => prev.filter(r => r.id !== id));
      storage?.delete?.(id).catch(error => onError?.(error));
    } catch (error) {
      console.error('Error deleting recording:', error);
      onError?.(error instanceof Error ? error : new Error('Failed to delete recording'));
    }
  }, [storage, onError]);

  const clearRecordings = useCallback(() => {
    setRecordings([]);
  }, []);

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
          setRecordings(loadedRecordings);
        })
        .catch(error => onError?.(error));
    }
  }, [storage, onError]);

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
    isRecording,
    recordingStartTime,
    
    // Playback State
    isPlaying,
    isPaused,
    hasEnded,
    currentTime,
    playbackSpeed,
    
    // Data
    recordings,
    currentRecording: loadedRecording,
    currentSnapshot,
    
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
  };
};
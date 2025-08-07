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

  // Internal recording hook
  const { handleEditorChange, recordingStartTime } = useRecording(
    editorRef,
    isRecording,
    isPlaying,
    captureEvents,
    (snapshot) => {
      if (currentRecording) {
        setCurrentRecording(prev => prev ? {
          ...prev,
          snapshots: [...prev.snapshots, snapshot]
        } : null);
      }
    }
  );

  // Internal playback hook
  const { getEditorState, applyEditorState } = usePlayback(
    editorRef,
    isPlaying,
    editorState,
    pauseOnUserInteraction,
    () => {
      pause();
      onPlaybackPause?.();
    }
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
    if (!loadedRecording || loadedRecording.snapshots.length === 0) return;
    
    setIsPlaying(true);
    setIsPaused(false);
    setHasEnded(false);
    playbackStartTimeRef.current = Date.now() - currentTime;
    
    onPlaybackStart?.();

    // Start the playback timeline
    const updatePlayback = () => {
      if (!playbackStartTimeRef.current) return;
      
      const elapsed = Date.now() - playbackStartTimeRef.current;
      const adjustedTime = elapsed * playbackSpeed;
      
      setCurrentTime(adjustedTime);
      
      // Find current snapshot to apply
      const currentSnapshotToApply = loadedRecording.snapshots
        .filter(s => s.timestamp <= adjustedTime)
        .pop();
      
      if (currentSnapshotToApply && currentSnapshotToApply !== currentSnapshot) {
        setCurrentSnapshot(currentSnapshotToApply);
        setEditorState({
          content: currentSnapshotToApply.state.content,
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
          clearInterval(playbackTimerRef.current);
          playbackTimerRef.current = null;
        }
        return;
      }
      
      // Continue playback
      playbackTimerRef.current = setTimeout(updatePlayback, 16); // ~60fps
    };
    
    updatePlayback();
  }, [loadedRecording, currentTime, playbackSpeed, currentSnapshot, onPlaybackStart]);

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
    
    // Clear current playback timer
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    
    setCurrentTime(targetTime);
    
    // Find the last snapshot before or at the target time
    let lastSnapshot: EditorSnapshot | null = null;
    
    for (let i = 0; i < loadedRecording.snapshots.length; i++) {
      const snapshot = loadedRecording.snapshots[i];
      if (snapshot.timestamp <= targetTime) {
        lastSnapshot = snapshot;
      } else {
        break;
      }
    }
    
    if (lastSnapshot) {
      setCurrentSnapshot(lastSnapshot);
      const newState = {
        content: lastSnapshot.state.content,
        selection: lastSnapshot.state.selection,
        position: lastSnapshot.state.position,
        viewState: lastSnapshot.state.viewState,
      };
      setEditorState(newState);
      
      // Apply the state immediately to the editor, even when not playing
      applyEditorState(newState);
    }
    
    onSeek?.(targetTime);
    
    // If playing, update playback start time and continue playback
    if (isPlaying) {
      playbackStartTimeRef.current = Date.now() - targetTime / playbackSpeed;
      
      // Continue the playback timeline from new position
      const updatePlayback = () => {
        if (!playbackStartTimeRef.current) return;
        
        const elapsed = Date.now() - playbackStartTimeRef.current;
        const adjustedTime = elapsed * playbackSpeed;
        
        setCurrentTime(adjustedTime);
        
        // Find current snapshot to apply
        const currentSnapshotToApply = loadedRecording.snapshots
          .filter(s => s.timestamp <= adjustedTime)
          .pop();
        
        if (currentSnapshotToApply && currentSnapshotToApply !== currentSnapshot) {
          setCurrentSnapshot(currentSnapshotToApply);
          setEditorState({
            content: currentSnapshotToApply.state.content,
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
            clearInterval(playbackTimerRef.current);
            playbackTimerRef.current = null;
          }
          return;
        }
        
        // Continue playback
        playbackTimerRef.current = setTimeout(updatePlayback, 16); // ~60fps
      };
      
      updatePlayback();
    }
  }, [loadedRecording, onSeek, isPlaying, playbackSpeed, currentSnapshot, applyEditorState]);

  const setPlaybackSpeed = useCallback((speed: number) => {
    setPlaybackSpeedState(speed);
  }, []);

  // Recording management
  const loadRecording = useCallback((recording: Recording) => {
    setLoadedRecording(recording);
    setCurrentTime(0);
    setIsPlaying(false);
    setIsPaused(false);
    setHasEnded(false);
    setCurrentSnapshot(null);
    
    // Reset editor state
    setEditorState({
      content: '',
      selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
      position: { lineNumber: 1, column: 1 } as monaco.Position,
      viewState: null,
    });
  }, []);

  const deleteRecording = useCallback((id: string) => {
    setRecordings(prev => prev.filter(r => r.id !== id));
    storage?.delete?.(id).catch(error => onError?.(error));
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
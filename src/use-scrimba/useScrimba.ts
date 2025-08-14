import { useState, useCallback, useEffect, useRef } from 'react';
import type * as monaco from 'monaco-editor';
import type {
  UseScrimbaConfig,
  UseScrimbaReturn,
  Recording,
  EditorSnapshot
} from './types';
import { useAudioRecording } from './hooks/useAudioRecording';
import { isValidSnapshotState, isEditorReady } from './utils/validation';
import { applyContentDiff } from './utils/editorDiff';

/**
 * Main useScrimba hook - provides Scrimba-like recording and playback functionality
 * Uses simple React state management like the demo
 */
export const useScrimba = (config: UseScrimbaConfig): UseScrimbaReturn => {
  const {
    editorRef,
    enableAudioRecording = false,
    onRecordingStart,
    onRecordingStop,
    onPlaybackStart,
    onPlaybackPause,
    onSeek,
    onError,
    onSnapshot,
    onStateChange,
    onPlaybackUpdate,
  } = config;

  // Simple React state management like the demo
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasEnded, setHasEnded] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeedState] = useState(1);
  const [volume, setVolumeState] = useState(1);
  const [currentRecording, setCurrentRecording] = useState<Recording | null>(null);
  const [currentSnapshot, setCurrentSnapshot] = useState<EditorSnapshot | null>(null);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);

  // Recording data like the demo
  const snapshotsRef = useRef<EditorSnapshot[]>([]);
  const startTimeRef = useRef<number>(0);

  // Audio instance management (replacing audioRef)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recordingDurationRef = useRef<number>(0);

  // Integrated audio recording
  const audioRecording = useAudioRecording();

  // Simple editor change handling like the demo
  const handleEditorChange = useCallback(() => {
    if (isRecording && editorRef.current) {
      const timestamp = performance.now() - startTimeRef.current;
      const editor = editorRef.current;

      const snapshot: EditorSnapshot = {
        timestamp,
        state: {
          content: editor.getValue(),
          selection: editor.getSelection() || {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
            selectionStartLineNumber: 1,
            selectionStartColumn: 1,
            positionLineNumber: 1,
            positionColumn: 1
          } as monaco.Selection,
          position: editor.getPosition() || {
            lineNumber: 1,
            column: 1
          } as monaco.Position,
          viewState: editor.saveViewState(),
        }
      };

      snapshotsRef.current.push(snapshot);
      onSnapshot?.(snapshot);
    }
  }, [isRecording, onSnapshot]);

  // Handle editor events
  useEffect(() => {
    if (!editorRef.current || !isRecording) return;

    const editor = editorRef.current;
    const model = editor.getModel();

    if (!model) return;

    // Listen for content changes
    const disposable = model.onDidChangeContent(() => {
      handleEditorChange();
    });

    return () => disposable.dispose();
  }, [isRecording, handleEditorChange]);

  // Recording controls like the demo
  const startRecording = useCallback(async () => {
    try {
      // Clear previous recording data
      snapshotsRef.current = [];

      // Set start time
      startTimeRef.current = performance.now();

      // Initialize with first snapshot
      if (editorRef.current) {
        const editor = editorRef.current;
        const initialSnapshot: EditorSnapshot = {
          timestamp: 0,
          state: {
            content: editor.getValue(),
            selection: editor.getSelection() || {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1,
              selectionStartLineNumber: 1,
              selectionStartColumn: 1,
              positionLineNumber: 1,
              positionColumn: 1
            } as monaco.Selection,
            position: editor.getPosition() || {
              lineNumber: 1,
              column: 1
            } as monaco.Position,
            viewState: editor.saveViewState(),
          }
        };
        snapshotsRef.current.push(initialSnapshot);
      }

      // Start audio recording if enabled
      if (enableAudioRecording) {
        try {
          await audioRecording.startRecording();
        } catch (error) {
          console.warn('Audio recording failed to start:', error);
        }
      }

      setIsRecording(true);
      setRecordingStartTime(Date.now());

      console.log('🎬 Recording started');
      onRecordingStart?.();
    } catch (error) {
      onError?.(error as Error);
    }
  }, [audioRecording, enableAudioRecording, onRecordingStart, onError]);

  const stopRecording = useCallback(async () => {
    try {
      if (!isRecording) return;

      // Stop audio recording if enabled and active
      if (enableAudioRecording && audioRecording.isRecordingAudio) {
        audioRecording.stopRecording();
      }

      const stopTime = performance.now();
      const duration = stopTime - startTimeRef.current;

      const recordingData: Recording = {
        id: Date.now().toString(),
        name: `Recording ${Date.now()}`,
        createdAt: Date.now(),
        snapshots: [...snapshotsRef.current],
        duration,
        audioBlob: enableAudioRecording ? (audioRecording.audioBlob || undefined) : undefined,
      };

      setIsRecording(false);
      setRecordingStartTime(null);

      console.log('🎬 Recording stopped');
      console.log('📏 Duration:', duration, 'ms');

      onRecordingStop?.(recordingData);
    } catch (error) {
      onError?.(error as Error);
    }
  }, [isRecording, audioRecording, enableAudioRecording, onRecordingStop, onError]);

  // Simple playback state management
  const cleanupPlayback = useCallback(() => {
    setIsPlaying(false);
    setIsPaused(true);
    setHasEnded(false);
    if (audioRef.current) {
      audioRef.current.pause();
    }
  }, []);

  // Apply editor state like the demo
  const applyEditorState = useCallback((snapshot: EditorSnapshot) => {
    if (!editorRef.current || !snapshot.state) return;

    const editor = editorRef.current;

    try {
      // Apply content
      applyContentDiff(editor, snapshot.state.content);

      // Apply position and selection
      if (editor.getValue() === snapshot.state.content) {
        const model = editor.getModel();
        if (model) {
          const lineCount = model.getLineCount();
          const safeLineNumber = Math.min(Math.max(snapshot.state.position.lineNumber, 1), lineCount);
          const lineLength = model.getLineLength(safeLineNumber);
          if (lineLength >= 0) {
            const maxColumn = Math.max(1, lineLength + 1);
            const validPosition = {
              lineNumber: safeLineNumber,
              column: Math.min(Math.max(snapshot.state.position.column, 1), maxColumn)
            };
            editor.setPosition(validPosition);
            editor.setSelection(snapshot.state.selection);

            if (snapshot.state.viewState) {
              try {
                editor.restoreViewState(snapshot.state.viewState);
              } catch (err) {
                console.error('View State Error:', err);
              }
            }
          }
        }
      }

      setCurrentSnapshot(snapshot);
      onStateChange?.(snapshot.state);
    } catch (error) {
      console.warn('Error applying editor state:', error);
    }
  }, [onStateChange]);

  // Timeupdate synchronization like the demo
  useEffect(() => {
    if (!isPlaying || !currentRecording) return;

    const hasAudio = audioRef?.current && currentRecording.audioBlob;
    const hasEditor = editorRef?.current && isEditorReady(editorRef.current);

    if (hasAudio) {
      // Use timeupdate event as single source of truth
      const audio = audioRef.current!;
      const editor = editorRef?.current;
      const snapshots = currentRecording.snapshots;

      const handleTimeUpdate = () => {
        if (!isPlaying || hasEnded) return;

        // Audio timeupdate is the single source of truth like the demo
        const audioCurrentTime = audio.currentTime * 1000; // Convert to milliseconds
        setCurrentTime(audioCurrentTime);

        // Apply editor state changes synchronously
        if (hasEditor && editor) {
          const validSnapshots = snapshots.filter(s => s?.timestamp !== undefined);
          const currentSnapshotToApply = validSnapshots
            .filter(s => s.timestamp <= audioCurrentTime)
            .pop();

          if (currentSnapshotToApply &&
            currentSnapshotToApply !== currentSnapshot &&
            currentSnapshotToApply.state &&
            isValidSnapshotState(currentSnapshotToApply.state)) {

            applyEditorState(currentSnapshotToApply);
            onPlaybackUpdate?.(audioCurrentTime, currentSnapshotToApply);
          }
        }
      };

      const handleAudioEnded = () => {
        setIsPlaying(false);
        setHasEnded(true);
        setCurrentTime(currentRecording.duration);
        console.log('🎯 Playback ended');
      };

      // Use timeupdate as single source of truth
      audio.addEventListener('timeupdate', handleTimeUpdate);
      audio.addEventListener('ended', handleAudioEnded);

      return () => {
        audio.removeEventListener('timeupdate', handleTimeUpdate);
        audio.removeEventListener('ended', handleAudioEnded);
        audio.pause();
      };
    }
  }, [isPlaying, currentRecording, currentSnapshot, hasEnded, onPlaybackUpdate]);

  // Simple playback controls like the demo
  const play = useCallback(() => {
    if (!currentRecording) {
      console.warn('Cannot play: no recording loaded');
      return;
    }

    // If playback has ended, restart from the beginning
    if (hasEnded) {
      setCurrentTime(0);
      setHasEnded(false);
    }

    const hasAudio = currentRecording.audioBlob;

    if (hasAudio) {
      // Create new Audio instance if needed
      if (!audioRef.current) {
        const audioUrl = URL.createObjectURL(currentRecording.audioBlob!);
        audioRef.current = new Audio(audioUrl);
        audioRef.current.volume = volume;
        // Store exact duration for progress calculation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (audioRef.current as any)._actualDuration = recordingDurationRef.current;
      }

      // Set audio position and playback rate
      audioRef.current.pause();
      audioRef.current.currentTime = currentTime / 1000;
      audioRef.current.playbackRate = playbackSpeed;

      // Play audio
      audioRef.current.play().catch(console.error);
    }

    setIsPlaying(true);
    setIsPaused(false);
    onPlaybackStart?.();
  }, [currentRecording, hasEnded, currentTime, volume, playbackSpeed, onPlaybackStart]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    setIsPaused(true);

    // Pause audio if available
    if (audioRef?.current) {
      audioRef.current.pause();
    }

    onPlaybackPause?.();
  }, [onPlaybackPause]);

  const stop = useCallback(() => {
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentTime(0);
    setHasEnded(false);

    // Stop audio if available
    if (audioRef?.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, []);

  const seekTo = useCallback((targetTime: number) => {
    if (!currentRecording) return;

    const clampedTime = Math.min(Math.max(targetTime, 0), currentRecording.duration);
    const wasPlaying = isPlaying;

    // Pause during seek
    if (wasPlaying) {
      setIsPlaying(false);
    }

    // Update audio position if available
    if (audioRef?.current && currentRecording.audioBlob) {
      audioRef.current.pause();
      audioRef.current.currentTime = clampedTime / 1000;
    }

    setCurrentTime(clampedTime);
    setHasEnded(false);

    // Find and apply the appropriate snapshot
    const validSnapshots = currentRecording.snapshots.filter(s => s?.timestamp !== undefined);
    const lastSnapshot = validSnapshots
      .filter(s => s.timestamp <= clampedTime)
      .pop();

    if (lastSnapshot) {
      applyEditorState(lastSnapshot);
    }

    onSeek?.(clampedTime);

    // Resume playback after seek
    if (wasPlaying) {
      setTimeout(() => {
        play();
      }, 0);
    }
  }, [currentRecording, isPlaying, onSeek, play]);

  const setPlaybackSpeed = useCallback((speed: number) => {
    setPlaybackSpeedState(speed);

    // Update audio playback rate if available
    if (audioRef?.current) {
      audioRef.current.playbackRate = speed;
    }
  }, []);

  const setVolume = useCallback((newVolume: number) => {
    const clampedVolume = Math.max(0, Math.min(newVolume, 1));
    setVolumeState(clampedVolume);

    // Update audio volume if available
    if (audioRef?.current) {
      audioRef.current.volume = clampedVolume;
    }
  }, []);

  // Simple loadRecording like the demo
  const loadRecording = useCallback((recording: Recording) => {
    if (!recording) {
      console.warn('Cannot load null/undefined recording');
      return;
    }

    // Clear any existing playback
    cleanupPlayback();

    // Clean up previous Audio instance
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
        URL.revokeObjectURL(audioRef.current.src);
      }
      audioRef.current = null;
    }

    // Calculate exact duration if audio available
    if (recording.audioBlob) {
      audioRecording.calculateExactDuration(recording.audioBlob).then(exactDuration => {
        recordingDurationRef.current = exactDuration;
        console.log('🎵 Exact duration calculated:', exactDuration, 'seconds');

        // Update recording duration if significantly different
        const recordedDurationSeconds = recording.duration / 1000;
        if (Math.abs(exactDuration - recordedDurationSeconds) > 0.1) {
          console.log('⚠️ Duration mismatch detected, updating recording');
          const updatedRecording = {
            ...recording,
            duration: exactDuration * 1000
          };
          setCurrentRecording(updatedRecording);
        }
      }).catch(error => {
        console.error('Failed to calculate exact duration:', error);
        recordingDurationRef.current = recording.duration / 1000;
      });
    }

    setCurrentRecording(recording);
    setCurrentTime(0);
    setHasEnded(false);
    setIsPlaying(false);
    setIsPaused(false);

    // Apply initial state
    if (recording.snapshots.length > 0) {
      applyEditorState(recording.snapshots[0]);
    }
  }, [cleanupPlayback, audioRecording]);



  // Simple helper functions
  const getSnapshot = useCallback((timestamp?: number): EditorSnapshot | null => {
    if (!currentRecording?.snapshots?.length) return null;

    if (timestamp === undefined) {
      return currentSnapshot;
    }

    // Find snapshot at or before the specified timestamp
    const validSnapshots = currentRecording.snapshots.filter(s => s?.timestamp !== undefined);
    return validSnapshots
      .filter(s => s.timestamp <= timestamp)
      .pop() || null;
  }, [currentRecording, currentSnapshot]);

  const getEditorState = useCallback(() => {
    if (!editorRef.current) return null;

    const editor = editorRef.current;
    return {
      content: editor.getValue(),
      selection: editor.getSelection() || {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
        selectionStartLineNumber: 1,
        selectionStartColumn: 1,
        positionLineNumber: 1,
        positionColumn: 1
      } as monaco.Selection,
      position: editor.getPosition() || {
        lineNumber: 1,
        column: 1
      } as monaco.Position,
      viewState: editor.saveViewState(),
    };
  }, []);

  return {
    // Recording State
    isRecording,
    isRecordingAudio: enableAudioRecording ? audioRecording.isRecordingAudio : false,
    recordingStartTime,

    // Playback State
    isPlaying,
    isPaused,
    hasEnded,
    currentTime,
    playbackSpeed,
    volume,

    // Data
    currentRecording,
    currentCursor: currentSnapshot?.state?.mouseCursor || null,

    // Recording Controls
    startRecording,
    stopRecording,

    // Playback Controls
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,

    // Recording Management
    loadRecording,

    // Monaco Editor Integration
    handleEditorChange,

    // Helper functions
    getEditorState,
    getSnapshot,
  };
};
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

// Extended HTMLAudioElement type for demo compatibility
type AudioElementWithDuration = HTMLAudioElement & { _actualDuration?: number };

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

  // Audio instance management like the demo
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recordingDurationRef = useRef<number>(0);
  
  // Independent timeline management (not dependent on audio.currentTime)
  const playbackStartTimeRef = useRef<number>(0);
  const playbackPausedAtRef = useRef<number>(0);
  const totalPausedTimeRef = useRef<number>(0);
  
  // Mouse cursor tracking
  const lastMousePositionRef = useRef<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false
  });

  // Integrated audio recording
  const audioRecording = useAudioRecording();

  // Calculate current timeline position independently of audio
  const getCurrentTimelinePosition = useCallback((): number => {
    if (!isPlaying) return currentTime;
    
    const now = performance.now();
    const elapsedSinceStart = now - playbackStartTimeRef.current - totalPausedTimeRef.current;
    const adjustedElapsed = elapsedSinceStart * playbackSpeed;
    
    return Math.max(0, adjustedElapsed);
  }, [isPlaying, currentTime, playbackSpeed]);

  // Duration calculation using FileReader like the demo
  const calculateDurationFromFileReader = useCallback(async (audioBlob: Blob): Promise<number> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = function(e) {
        try {
          const arrayBuffer = e.target?.result as ArrayBuffer;
          const audioContext = new window.AudioContext();
          
          audioContext.decodeAudioData(
            arrayBuffer,
            buffer => {
              const rawDuration = buffer.duration;
              const adjustedDuration = rawDuration - 0.06; // Subtract 0.06s for exact end time
              console.log('FileReader raw duration:', rawDuration, 'seconds');
              console.log('Adjusted duration:', adjustedDuration, 'seconds');
              audioContext.close();
              resolve(adjustedDuration);
            },
            error => {
              console.error('FileReader decode error:', error);
              audioContext.close();
              reject(error);
            }
          );
        } catch (error) {
          console.error('FileReader processing error:', error);
          reject(error);
        }
      };
      
      reader.onerror = function() {
        console.error('FileReader read error');
        reject(new Error('FileReader failed'));
      };
      
      reader.readAsArrayBuffer(audioBlob);
    });
  }, []);

  // Simple editor change handling like the demo
  const handleEditorChange = useCallback(() => {
    if (isRecording && editorRef.current) {
      const timestamp = performance.now() - startTimeRef.current;
      const editor = editorRef.current;

      const currentSelection = editor.getSelection();
      const currentPosition = editor.getPosition();
      
      // Get current mouse cursor position relative to document
      const mouseCursorPosition = lastMousePositionRef.current;
      
      const snapshot: EditorSnapshot = {
        timestamp,
        state: {
          content: editor.getValue(),
          selection: currentSelection || {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
            selectionStartLineNumber: 1,
            selectionStartColumn: 1,
            positionLineNumber: 1,
            positionColumn: 1
          } as monaco.Selection,
          position: currentPosition || {
            lineNumber: 1,
            column: 1
          } as monaco.Position,
          viewState: editor.saveViewState(),
          mouseCursor: mouseCursorPosition,
        }
      };

      // Debug logging for recording
      console.log('📸 Recording snapshot:', {
        timestamp,
        position: currentPosition,
        selection: currentSelection,
        mouseCursor: mouseCursorPosition,
        contentLength: snapshot.state.content.length
      });

      snapshotsRef.current.push(snapshot);
      onSnapshot?.(snapshot);
    }
  }, [isRecording, onSnapshot, editorRef]);

  // Handle editor events
  useEffect(() => {
    if (!editorRef.current || !isRecording) return;

    const editor = editorRef.current;
    const model = editor.getModel();

    if (!model) return;

    // Listen for content changes
    const contentDisposable = model.onDidChangeContent(() => {
      handleEditorChange();
    });

    // Listen for cursor position changes
    const positionDisposable = editor.onDidChangeCursorPosition(() => {
      handleEditorChange();
    });

    // Listen for selection changes
    const selectionDisposable = editor.onDidChangeCursorSelection(() => {
      handleEditorChange();
    });

    return () => {
      contentDisposable.dispose();
      positionDisposable.dispose();
      selectionDisposable.dispose();
    };
  }, [isRecording, handleEditorChange, editorRef]);

  // Handle mouse cursor recording
  useEffect(() => {
    if (!isRecording) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Update mouse position on every movement for smooth playback
      lastMousePositionRef.current = {
        x: e.clientX,
        y: e.clientY,
        visible: true
      };
      
      // Record every mouse movement for smooth cursor playback
      handleEditorChange();
    };

    const handleMouseLeave = () => {
      lastMousePositionRef.current = {
        ...lastMousePositionRef.current,
        visible: false
      };
    };

    const handleMouseEnter = () => {
      lastMousePositionRef.current = {
        ...lastMousePositionRef.current,
        visible: true
      };
    };

    // Add mouse event listeners to document
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
    };
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
            mouseCursor: lastMousePositionRef.current,
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
  }, [audioRecording, enableAudioRecording, onRecordingStart, onError, editorRef]);

  const stopRecording = useCallback(async () => {
    try {
      if (!isRecording) return;

      // Stop audio recording if enabled and active
      let finalAudioBlob: Blob | undefined;
      if (enableAudioRecording && audioRecording.isRecordingAudio) {
        finalAudioBlob = (await audioRecording.stopRecording()) || undefined;
      }

      const stopTime = performance.now();
      const duration = stopTime - startTimeRef.current;

      // Calculate exact duration using FileReader if audio available
      let finalDuration = duration;
      if (enableAudioRecording && finalAudioBlob) {
        try {
          const exactDuration = await calculateDurationFromFileReader(finalAudioBlob);
          finalDuration = exactDuration * 1000; // Convert to milliseconds
          recordingDurationRef.current = exactDuration;
          console.log('🎵 Exact duration calculated:', exactDuration, 'seconds');
        } catch (error) {
          console.error('Failed to calculate exact duration:', error);
          recordingDurationRef.current = duration / 1000;
        }
      }

      const recordingData: Recording = {
        id: Date.now().toString(),
        name: `Recording ${Date.now()}`,
        createdAt: Date.now(),
        snapshots: [...snapshotsRef.current],
        duration: finalDuration,
        audioBlob: enableAudioRecording ? finalAudioBlob : undefined,
      };

      setIsRecording(false);
      setRecordingStartTime(null);

      console.log('🎬 Recording stopped');
      console.log('📏 Duration:', duration, 'ms');

      onRecordingStop?.(recordingData);
    } catch (error) {
      onError?.(error as Error);
    }
  }, [isRecording, audioRecording, enableAudioRecording, onRecordingStop, onError, calculateDurationFromFileReader]);

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
            // Debug logging for playback
            console.log('🎬 Applying editor state:', {
              position: validPosition,
              selection: snapshot.state.selection,
              hasViewState: !!snapshot.state.viewState
            });
            
            // Focus editor for cursor visibility during playback
            editor.focus();
            editor.setPosition(validPosition);
            editor.setSelection(snapshot.state.selection);

            if (snapshot.state.viewState) {
              try {
                editor.restoreViewState(snapshot.state.viewState);
              } catch (err) {
                console.error('View State Error:', err);
              }
            }
            
            // Verify what was actually applied
            console.log('✅ Editor state after apply:', {
              actualPosition: editor.getPosition(),
              actualSelection: editor.getSelection()
            });
          }
        }
      }

      setCurrentSnapshot(snapshot);
      onStateChange?.(snapshot.state);
    } catch (error) {
      console.warn('Error applying editor state:', error);
    }
  }, [onStateChange, editorRef]);

  // Independent timeline playback synchronization
  useEffect(() => {
    if (!isPlaying || !currentRecording) return;

    const editor = editorRef?.current;
    const snapshots = currentRecording.snapshots;
    const hasEditor = editor && isEditorReady(editor);
    const totalDuration = recordingDurationRef.current * 1000; // Convert to milliseconds
    let animationFrameId: number;

    // Smooth animation loop for 60fps playback using independent timeline
    const updatePlayback = () => {
      if (!isPlaying || hasEnded) return;

      // Get current timeline position (independent of audio)
      const timelinePosition = getCurrentTimelinePosition();
      setCurrentTime(timelinePosition);

      // Check if we've reached the end
      if (timelinePosition >= totalDuration) {
        setIsPlaying(false);
        setHasEnded(true);
        setCurrentTime(totalDuration);
        console.log('🎯 Playback ended');
        return;
      }

      // Apply editor state changes synchronously at 60fps
      if (hasEditor) {
        const validSnapshots = snapshots.filter(s => s?.timestamp !== undefined);
        for (let i = validSnapshots.length - 1; i >= 0; i--) {
          if (validSnapshots[i].timestamp <= timelinePosition) {
            const snapshotToApply = validSnapshots[i];
            if (snapshotToApply &&
                snapshotToApply !== currentSnapshot &&
                snapshotToApply.state &&
                isValidSnapshotState(snapshotToApply.state)) {
              applyEditorState(snapshotToApply);
              onPlaybackUpdate?.(timelinePosition, snapshotToApply);
            }
            break;
          }
        }
      }

      // Continue the animation loop
      animationFrameId = requestAnimationFrame(updatePlayback);
    };

    // Start the smooth animation loop
    animationFrameId = requestAnimationFrame(updatePlayback);

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isPlaying, currentRecording, currentSnapshot, hasEnded, onPlaybackUpdate, applyEditorState, editorRef, getCurrentTimelinePosition]);

  // Audio management (only for start trigger and duration reference)
  useEffect(() => {
    if (!isPlaying || !currentRecording?.audioBlob || !audioRef.current) return;

    const audio = audioRef.current;

    const handleLoadedMetadata = () => {
      // Set the exact duration like the demo (for reference only)
      (audio as AudioElementWithDuration)._actualDuration = recordingDurationRef.current;
      console.log('Setting audio._actualDuration:', recordingDurationRef.current);
    };

    const handleAudioEnded = () => {
      // Audio ended - this is just for cleanup, timeline manages the end
      console.log('🎵 Audio track ended');
    };

    // Add audio event listeners
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleAudioEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleAudioEnded);
    };
  }, [isPlaying, currentRecording]);

  // Simple playback controls like the demo
  const play = useCallback(() => {
    if (!currentRecording) {
      console.warn('Cannot play: no recording loaded');
      return;
    }

    console.log('🎯 Play called:', {
      hasAudio: !!currentRecording.audioBlob,
      audioRefExists: !!audioRef.current,
      recordingDuration: recordingDurationRef.current
    });

    // Check if we're restarting from the end
    const isRestarting = hasEnded;
    
    // If playback has ended, restart from the beginning
    if (hasEnded) {
      setCurrentTime(0);
      setHasEnded(false);
      console.log('🔄 Restarting playback from beginning');
    }

    // Initialize independent timeline
    const now = performance.now();
    
    if (isPaused && playbackPausedAtRef.current > 0 && !isRestarting) {
      // Resuming from pause (but not restarting) - add pause duration to total paused time
      totalPausedTimeRef.current += now - playbackPausedAtRef.current;
      playbackPausedAtRef.current = 0;
    } else {
      // Starting fresh or restarting from end
      playbackStartTimeRef.current = now;
      totalPausedTimeRef.current = 0;
      playbackPausedAtRef.current = 0;
      
      // Only adjust start time for seek, not for restart
      if (currentTime > 0 && !isRestarting) {
        playbackStartTimeRef.current -= currentTime / playbackSpeed;
      }
    }

    const hasAudio = currentRecording.audioBlob;

    if (hasAudio) {
      // Create Audio instance if needed like the demo
      if (!audioRef.current) {
        console.log('🎵 Creating Audio instance for playback');
        const audioUrl = URL.createObjectURL(currentRecording.audioBlob!);
        audioRef.current = new Audio(audioUrl);
        (audioRef.current as AudioElementWithDuration)._actualDuration = recordingDurationRef.current;
      }

      // Apply initial state like the demo (always when playing, especially when restarting)
      if (currentRecording.snapshots.length > 0 && editorRef.current) {
        // When restarting or starting fresh, always apply the first snapshot
        if (isRestarting || currentTime === 0) {
          console.log('🎬 Applying initial snapshot for restart/fresh start');
        }
        applyEditorState(currentRecording.snapshots[0]);
      }

      // Set audio position and playback rate (audio follows our timeline)
      audioRef.current.currentTime = currentTime / 1000;
      audioRef.current.playbackRate = playbackSpeed;
      audioRef.current.volume = volume;

      console.log('🎮 Starting independent timeline at', currentTime, 'ms');
      if (isRestarting) {
        console.log('🔄 Audio restarted from position 0');
      }
      // Play audio (it will follow our independent timeline)
      audioRef.current.play().catch(console.error);
    } else {
      console.warn('⚠️ No audio blob found in recording');
    }

    setIsPlaying(true);
    setIsPaused(false);
    onPlaybackStart?.();
  }, [currentRecording, hasEnded, currentTime, volume, playbackSpeed, onPlaybackStart, applyEditorState, editorRef, isPaused]);

  const pause = useCallback(() => {
    // Record when we paused for timeline calculation
    playbackPausedAtRef.current = performance.now();
    
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

    const totalDuration = recordingDurationRef.current * 1000; // Convert to milliseconds
    const clampedTime = Math.min(Math.max(targetTime, 0), totalDuration);
    
    // Update current time
    setCurrentTime(clampedTime);
    setHasEnded(false);

    // Reset timeline to new position
    const now = performance.now();
    playbackStartTimeRef.current = now - (clampedTime / playbackSpeed);
    totalPausedTimeRef.current = 0;
    playbackPausedAtRef.current = 0;

    // Update audio position if available
    if (audioRef.current) {
      audioRef.current.currentTime = clampedTime / 1000;
    }

    // Find and apply the appropriate snapshot immediately like the demo
    const validSnapshots = currentRecording.snapshots.filter(s => s?.timestamp !== undefined);
    for (let i = validSnapshots.length - 1; i >= 0; i--) {
      if (validSnapshots[i].timestamp <= clampedTime) {
        applyEditorState(validSnapshots[i]);
        break;
      }
    }

    onSeek?.(clampedTime);

    // Continue playing if it was playing
    if (audioRef.current && audioRef.current.paused && isPlaying) {
      audioRef.current.play().catch(console.error);
    }
  }, [currentRecording, isPlaying, onSeek, applyEditorState, playbackSpeed]);

  const setPlaybackSpeed = useCallback((speed: number) => {
    if (isPlaying) {
      // Adjust timeline when changing speed during playback
      const currentPos = getCurrentTimelinePosition();
      const now = performance.now();
      playbackStartTimeRef.current = now - (currentPos / speed) - totalPausedTimeRef.current;
    }
    
    setPlaybackSpeedState(speed);

    // Update audio playback rate if available
    if (audioRef?.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [isPlaying, getCurrentTimelinePosition]);

  const setVolume = useCallback((newVolume: number) => {
    const clampedVolume = Math.max(0, Math.min(newVolume, 1));
    setVolumeState(clampedVolume);

    // Update audio volume if available
    if (audioRef?.current) {
      audioRef.current.volume = clampedVolume;
    }
  }, []);

  // Simple loadRecording like the demo
  const loadRecording = useCallback(async (recording: Recording) => {
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
      try {
        const exactDuration = await calculateDurationFromFileReader(recording.audioBlob);
        recordingDurationRef.current = exactDuration;
        console.log('🎵 Exact duration calculated:', exactDuration, 'seconds');

        // Create new Audio instance like the demo
        const audioUrl = URL.createObjectURL(recording.audioBlob);
        audioRef.current = new Audio(audioUrl);
        
        // Set the exact duration like the demo
        (audioRef.current as AudioElementWithDuration)._actualDuration = exactDuration;
        
        // Update recording duration if significantly different
        const recordedDurationSeconds = recording.duration / 1000;
        if (Math.abs(exactDuration - recordedDurationSeconds) > 0.1) {
          console.log('⚠️ Duration mismatch detected, updating recording');
          recording = {
            ...recording,
            duration: exactDuration * 1000
          };
        }
      } catch (error) {
        console.error('Failed to calculate exact duration:', error);
        recordingDurationRef.current = recording.duration / 1000;
      }
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
  }, [cleanupPlayback, calculateDurationFromFileReader, applyEditorState]);



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
  }, [editorRef]);

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
    actualDuration: recordingDurationRef.current,

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
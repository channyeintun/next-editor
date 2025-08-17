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
    pauseOnUserInteraction = true,
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

  // Cursor decoration management for playback
  const cursorDecorationRef = useRef<string[]>([]);

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

      reader.onload = function (e) {
        try {
          const arrayBuffer = e.target?.result as ArrayBuffer;
          const audioContext = new window.AudioContext();

          audioContext.decodeAudioData(
            arrayBuffer,
            buffer => {
              const rawDuration = buffer.duration;
              const adjustedDuration = rawDuration - 0.06; // Subtract 0.06s for exact end time
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

      reader.onerror = function () {
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

      const content = editor.getValue();
      const currentSelection = editor.getSelection();
      const currentPosition = editor.getPosition();
      const viewState = editor.saveViewState();

      // Get current mouse cursor position relative to document
      const mouseCursorPosition = lastMousePositionRef.current;

      const snapshot: EditorSnapshot = {
        timestamp,
        state: {
          content,
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
          viewState,
          mouseCursor: mouseCursorPosition,
        }
      };

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

    const disposables: monaco.IDisposable[] = [];

    // Listen for content changes
    const contentDisposable = model.onDidChangeContent(() => {
      handleEditorChange();
    });
    disposables.push(contentDisposable);

    // Listen for cursor position changes
    const positionDisposable = editor.onDidChangeCursorPosition(() => {
      handleEditorChange();
    });
    disposables.push(positionDisposable);

    // Listen for selection changes
    const selectionDisposable = editor.onDidChangeCursorSelection(() => {
      handleEditorChange();
    });
    disposables.push(selectionDisposable);

    // Listen for scroll changes if enabled
    const scrollDisposable = editor.onDidScrollChange(() => {
      handleEditorChange();
    });
    disposables.push(scrollDisposable);

    return () => {
      disposables.forEach(d => d.dispose());
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

    // Handle iframe mouse tracking
    const handleIframeMouseMove = (iframe: HTMLIFrameElement) => (e: MouseEvent) => {
      // Get iframe position relative to viewport
      const iframeRect = iframe.getBoundingClientRect();
      
      // Calculate mouse position relative to the main document
      const documentX = iframeRect.left + e.clientX;
      const documentY = iframeRect.top + e.clientY;

      lastMousePositionRef.current = {
        x: documentX,
        y: documentY,
        visible: true
      };

      // Record mouse movement in iframe
      handleEditorChange();
    };

    const handleIframeMouseLeave = () => {
      lastMousePositionRef.current = {
        ...lastMousePositionRef.current,
        visible: false
      };
    };

    // Add mouse event listeners to document
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);

    // Add listeners to all iframes on the page
    const iframeListeners: Array<{ iframe: HTMLIFrameElement; listeners: Array<() => void> }> = [];
    
    const setupIframeListeners = (iframe: HTMLIFrameElement) => {
      try {
        const iframeWindow = iframe.contentWindow;
        const iframeDocument = iframe.contentDocument;
        
        if (iframeWindow && iframeDocument) {
          const mouseMoveHandler = handleIframeMouseMove(iframe);
          
          iframeDocument.addEventListener('mousemove', mouseMoveHandler);
          iframeDocument.addEventListener('mouseleave', handleIframeMouseLeave);
          
          iframeListeners.push({
            iframe,
            listeners: [
              () => iframeDocument.removeEventListener('mousemove', mouseMoveHandler),
              () => iframeDocument.removeEventListener('mouseleave', handleIframeMouseLeave)
            ]
          });
        }
      } catch (error) {
        // Iframe might be cross-origin, skip it
        console.warn('Cannot track cursor in iframe (likely cross-origin):', error);
      }
    };

    const attachToIframe = (iframe: HTMLIFrameElement) => {
      try {
        if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
          setupIframeListeners(iframe);
        } else {
          iframe.addEventListener('load', () => setupIframeListeners(iframe));
        }
      } catch (error) {
        console.warn('Cannot access iframe:', error);
      }
    };

    // Setup listeners for existing iframes
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(attachToIframe);

    // Watch for new iframes being added to the DOM
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            
            // Check if the added node is an iframe
            if (element.tagName === 'IFRAME') {
              attachToIframe(element as HTMLIFrameElement);
            }
            
            // Check if any descendant nodes are iframes
            const descendantIframes = element.querySelectorAll('iframe');
            descendantIframes.forEach(attachToIframe);
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
      
      // Stop observing for new iframes
      observer.disconnect();
      
      // Clean up iframe listeners
      iframeListeners.forEach(({ listeners }) => {
        listeners.forEach(cleanup => cleanup());
      });
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
    
    // Clear cursor decorations
    if (editorRef.current && cursorDecorationRef.current.length > 0) {
      cursorDecorationRef.current = editorRef.current.deltaDecorations(
        cursorDecorationRef.current,
        []
      );
    }
  }, [editorRef]);

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

            // Set cursor position and highlight with decoration instead of focus
            editor.setPosition(validPosition);
            editor.setSelection(snapshot.state.selection);
            
            // Add cursor decorations only during playback
            if (isPlaying) {
              const newDecorations = [];
              
              // Get all current selections to decorate all cursors
              const currentSelections = editor.getSelections() || [snapshot.state.selection];
              
              currentSelections.forEach((selection) => {
                // Get cursor position for this selection
                const cursorPos = selection.getPosition();
                
                newDecorations.push({
                  range: new monaco.Range(
                    cursorPos.lineNumber,
                    cursorPos.column,
                    cursorPos.lineNumber,
                    cursorPos.column
                  ),
                  options: {
                    className: 'playback-cursor-decoration',
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    minimap: {
                      color: '#007ACC',
                      position: monaco.editor.MinimapPosition.Inline
                    },
                    overviewRuler: {
                      color: '#007ACC',
                      position: monaco.editor.OverviewRulerLane.Center
                    }
                  }
                });
              });
              
              // Update cursor decorations
              cursorDecorationRef.current = editor.deltaDecorations(
                cursorDecorationRef.current,
                newDecorations
              );
            }

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
  }, [onStateChange, editorRef, isPlaying]);

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
        
        // Clear cursor decorations when playback ends naturally
        if (editorRef?.current && cursorDecorationRef.current.length > 0) {
          cursorDecorationRef.current = editorRef.current.deltaDecorations(
            cursorDecorationRef.current,
            []
          );
        }
        
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
    };

    // Add audio event listeners
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [isPlaying, currentRecording]);

  // Simple playback controls like the demo
  const play = useCallback(() => {
    if (!currentRecording) {
      console.warn('Cannot play: no recording loaded');
      return;
    }

    // Check if we're restarting from the end
    const isRestarting = hasEnded;

    // If playback has ended, restart from the beginning
    if (hasEnded) {
      setCurrentTime(0);
      setHasEnded(false);
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
        const audioUrl = URL.createObjectURL(currentRecording.audioBlob!);
        audioRef.current = new Audio(audioUrl);
        (audioRef.current as AudioElementWithDuration)._actualDuration = recordingDurationRef.current;
      }

      // Apply initial state like the demo (always when playing, especially when restarting)
      if (currentRecording.snapshots.length > 0 && editorRef.current) {
        // When restarting or starting fresh, always apply the first snapshot
        applyEditorState(currentRecording.snapshots[0]);
      }

      // Set audio position and playback rate (audio follows our timeline)
      audioRef.current.currentTime = currentTime / 1000;
      audioRef.current.playbackRate = playbackSpeed;
      audioRef.current.volume = volume;

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

    // Clear cursor decorations when paused
    if (editorRef.current && cursorDecorationRef.current.length > 0) {
      cursorDecorationRef.current = editorRef.current.deltaDecorations(
        cursorDecorationRef.current,
        []
      );
    }

    onPlaybackPause?.();
  }, [onPlaybackPause, editorRef]);

  // Setup user interaction listeners during playback
  useEffect(() => {
    if (isPlaying && pauseOnUserInteraction && editorRef.current) {
      const editor = editorRef.current;
      const disposables: monaco.IDisposable[] = [];

      // Listen for user mouse clicks during replay
      disposables.push(
        editor.onMouseDown(() => {
          pause();
        })
      );

      // Listen for user keyboard input during replay
      disposables.push(
        editor.onKeyDown(() => {
          pause();
        })
      );

      return () => {
        disposables.forEach(d => d.dispose());
      };
    }
  }, [isPlaying, pauseOnUserInteraction, editorRef, pause]);

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

    // Clear cursor decorations when stopped
    if (editorRef.current && cursorDecorationRef.current.length > 0) {
      cursorDecorationRef.current = editorRef.current.deltaDecorations(
        cursorDecorationRef.current,
        []
      );
    }
  }, [editorRef]);

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

        // Create new Audio instance like the demo
        const audioUrl = URL.createObjectURL(recording.audioBlob);
        audioRef.current = new Audio(audioUrl);

        // Set the exact duration like the demo
        (audioRef.current as AudioElementWithDuration)._actualDuration = exactDuration;

        // Update recording duration if significantly different
        const recordedDurationSeconds = recording.duration / 1000;
        if (Math.abs(exactDuration - recordedDurationSeconds) > 0.1) {
          // console.log('⚠️ Duration mismatch detected, updating recording');
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
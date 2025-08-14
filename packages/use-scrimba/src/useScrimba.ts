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
  updateLoadedRecordingDuration,
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
  const endingSynchronizedRef = useRef<boolean>(false);
  const pendingDurationUpdateRef = useRef<number | null>(null);

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

  const stopRecording = useCallback(async (options?: { audioBlob?: Blob; masterDuration?: number }) => {
    try {
      if (recording.currentRecording && recordingStartTime) {
        // Synchronize snapshot recording stop operations
        await Promise.allSettled([
          // Stop snapshot recording and include audio blob if provided
          Promise.resolve(store.dispatch(stopRecordingAction({ audioBlob: options?.audioBlob }))),
          // Ensure we have final recording state
          Promise.resolve(store.getState().recording.currentRecording)
        ]);

        const currentRecordingData = store.getState().recording.currentRecording;
        if (currentRecordingData) {
          // Use masterDuration if provided to ensure both recordings have same duration
          let finalDuration = options?.masterDuration || currentRecordingData.duration;
          
          // Ensure we have a valid finite duration
          if (!isFinite(finalDuration) || finalDuration <= 0) {
            console.warn('⚠️ Invalid finalDuration:', finalDuration, 'using fallback');
            finalDuration = currentRecordingData.duration;
            
            // If still invalid, use a default based on recording time
            if (!isFinite(finalDuration) || finalDuration <= 0) {
              finalDuration = recordingStartTime ? Date.now() - recordingStartTime : 0;
              console.warn('⚠️ Using calculated duration from recording time:', finalDuration, 'ms');
            }
          }
          
          const recordingData: Recording = {
            id: Date.now().toString(),
            name: `Recording ${Date.now()}`,
            createdAt: Date.now(),
            snapshots: currentRecordingData.snapshots,
            duration: finalDuration, // Use validated duration
            audioBlob: currentRecordingData.audioBlob,
          };
          
          console.log('📏 Final recording duration set to:', finalDuration, 'ms');

          // Synchronize final cleanup operations
          await Promise.allSettled([
            Promise.resolve(store.dispatch(clearCurrentRecording())),
            Promise.resolve(onRecordingStop?.(recordingData))
          ]);
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
      
      // Synchronized ending function using Promise.allSettled()
      const synchronizedEnd = async () => {
        if (endingSynchronizedRef.current) return; // Prevent double execution
        endingSynchronizedRef.current = true;
        
        // Synchronize all ending operations - let audio control the final time
        await Promise.allSettled([
          // End the playback state (don't force update currentTime)
          Promise.resolve(store.dispatch(end())),
          // Apply any pending duration updates now that playback has ended
          Promise.resolve().then(() => {
            if (pendingDurationUpdateRef.current) {
              console.log('⚡ Applying pending duration update after natural end:', pendingDurationUpdateRef.current, 'ms');
              store.dispatch(updateLoadedRecordingDuration(pendingDurationUpdateRef.current));
              pendingDurationUpdateRef.current = null;
            }
          }),
          // Clean up timeline
          Promise.resolve().then(() => {
            masterTimelineStartRef.current = null;
            if (playbackTimerRef.current) {
              cancelAnimationFrame(playbackTimerRef.current);
              playbackTimerRef.current = null;
            }
          })
        ]);
        
        console.log('🎯 Playback ended naturally with audio');
        
        endingSynchronizedRef.current = false;
      };
      
      const masterTimelineUpdate = () => {
        const currentState = store.getState().playback;
        if (!currentState.isPlaying || currentState.hasEnded) {
          console.log('🛑 Stopping RAF loop - not playing or ended');
          return;
        }
        
        // CRITICAL: Stop RAF if audio is paused or ended
        if (audio.paused || audio.ended) {
          console.log('🛑 Stopping RAF loop - audio paused or ended');
          return;
        }
        
        // MASTER TIMELINE: Audio is the ONLY source of truth
        const audioCurrentTime = audio.currentTime * 1000; // Convert to milliseconds
        const masterTime = audioCurrentTime;
        
        // CRITICAL: Don't update currentTime if playback has ended to prevent 0% jump
        const freshState = store.getState().playback;
        if (freshState.hasEnded) {
          console.log('🛑 Stopping RAF loop - playback ended');
          return; // Preserve the final currentTime set by end() action
        }
        
        // Update Redux state with audio's natural timing
        store.dispatch(updateCurrentTime(masterTime));
        
        // Store pending duration updates but DON'T apply them during active playback
        const playbackState = store.getState().playback;
        if (playbackState.loadedRecording && audio.duration && isFinite(audio.duration)) {
          const actualAudioDuration = audio.duration * 1000;
          if (Math.abs(actualAudioDuration - playbackState.loadedRecording.duration) > 100) {
            // Duration mismatch detected - defer update to prevent first-time pause
            if (!pendingDurationUpdateRef.current) {
              console.log('📦 Storing pending duration update for later:', actualAudioDuration, 'ms');
              pendingDurationUpdateRef.current = actualAudioDuration;
            }
            // Never apply duration updates during active playback to prevent pause issues
          }
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
        
        // Check if playback should end - ONLY when audio naturally ends
        if (audio.ended) {
          // Let audio control when we end - use its natural ending
          synchronizedEnd();
          return; // STOP RAF loop completely
        }
        
        // Final check: Don't continue RAF if audio is paused or playback stopped
        const finalCheck = store.getState().playback;
        if (finalCheck.hasEnded || !finalCheck.isPlaying || audio.paused) {
          console.log('🛑 Final RAF check - stopping loop');
          return; // STOP RAF loop - playback has ended or audio paused
        }
        
        // Continue master timeline
        playbackTimerRef.current = requestAnimationFrame(masterTimelineUpdate);
      };
      
      // Start master timeline
      masterTimelineUpdate();
      
      // Handle audio events - only essential ones
      const handleAudioEnded = async () => {
        const state = store.getState().playback;
        if (state.isPlaying && state.loadedRecording && !endingSynchronizedRef.current) {
          // Use synchronized ending
          endingSynchronizedRef.current = true;
          
          await Promise.allSettled([
            // Set to exact recording duration
            Promise.resolve(store.dispatch(updateCurrentTime(state.loadedRecording.duration))),
            // End playback state
            Promise.resolve(store.dispatch(end())),
            // Clean up
            Promise.resolve().then(() => {
              masterTimelineStartRef.current = null;
              if (playbackTimerRef.current) {
                cancelAnimationFrame(playbackTimerRef.current);
                playbackTimerRef.current = null;
              }
            })
          ]);
          
          endingSynchronizedRef.current = false;
        }
      };
      
      const handleAudioPause = () => {
        console.log('🎧 Audio pause event detected');
        
        // Immediate check for unexpected pauses
        const currentState = store.getState().playback;
        
        // Only trigger pause if we're in playing state and audio is genuinely paused
        if (currentState.isPlaying && audio.paused && !audio.ended) {
          console.log('⚠️ Unexpected audio pause detected at', Math.round((audio.currentTime * 1000)), 'ms - syncing state');
          handlePlaybackPause();
        } else {
          console.log('🔍 Audio pause ignored - state:', {
            isPlaying: currentState.isPlaying,
            audioPaused: audio.paused,
            audioEnded: audio.ended,
            currentTime: Math.round(audio.currentTime * 1000)
          });
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
      // Reset master timeline reference and synchronized ending for fresh start
      masterTimelineStartRef.current = null;
      endingSynchronizedRef.current = false;
    }
    
    store.dispatch(playAction());
    // Get fresh state after dispatching actions
    const currentState = store.getState().playback;
    const hasAudio = currentState.loadedRecording?.audioBlob && audioRef?.current;
    
    if (hasAudio) {
      // Set audio position and playback rate ONLY once, then let it play naturally
      audioRef!.current!.pause();
      audioRef!.current!.currentTime = currentState.currentTime / 1000;
      audioRef!.current!.playbackRate = currentState.playbackSpeed;
      
      // Let audio play naturally - never touch currentTime again during playback
      audioRef!.current!.play().catch(console.error);
      onPlaybackStart?.();
      
      // Reset synchronized ending for new playback
      endingSynchronizedRef.current = false;
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
        if (adjustedTime >= currentState.loadedRecording.duration) {
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
    
    // Reset synchronized ending when pausing
    endingSynchronizedRef.current = false;
    
    // Apply any pending duration updates now that playback is paused
    if (pendingDurationUpdateRef.current && playback.loadedRecording) {
      console.log('⚡ Applying pending duration update after pause:', pendingDurationUpdateRef.current, 'ms');
      store.dispatch(updateLoadedRecordingDuration(pendingDurationUpdateRef.current));
      pendingDurationUpdateRef.current = null;
    }
    
    // Keep master timeline reference for resume
  }, [store, audioRef, playback.loadedRecording]);

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
    
    // Apply any pending duration updates now that playback is stopped
    if (pendingDurationUpdateRef.current && playback.loadedRecording) {
      console.log('⚡ Applying pending duration update after stop:', pendingDurationUpdateRef.current, 'ms');
      store.dispatch(updateLoadedRecordingDuration(pendingDurationUpdateRef.current));
      pendingDurationUpdateRef.current = null;
    }
    
    // Reset master timeline reference and synchronized ending
    masterTimelineStartRef.current = null;
    endingSynchronizedRef.current = false;
  }, [store, audioRef, playback.loadedRecording]);

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
    
    // Reset master timeline reference and synchronized ending for seek
    masterTimelineStartRef.current = null;
    endingSynchronizedRef.current = false;
    
    // Update audio position if available - this is the ONLY time we set audio currentTime
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
      
      // When audio metadata loads, ensure recording duration matches audio duration exactly
      const handleAudioLoaded = () => {
        if (audioRef.current && isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
          const actualAudioDuration = audioRef.current.duration * 1000; // Convert to ms
          const recordedDuration = recording.duration;
          
          console.log('🎵 Audio loaded - recorded duration:', recordedDuration, 'ms');
          console.log('🎵 Audio loaded - actual duration:', actualAudioDuration, 'ms');
          
          // If durations don't match, update duration but DON'T interfere with active playback
          if (Math.abs(actualAudioDuration - recordedDuration) > 100) { // 100ms threshold
            console.log('⚠️ Duration mismatch, updating recording to match audio');
            
            // Check if we're currently playing - if so, defer update to prevent interference
            const currentPlaybackState = store.getState().playback;
            if (currentPlaybackState.isPlaying) {
              console.log('🔄 Playback active - deferring duration update to prevent first-time pause');
              pendingDurationUpdateRef.current = actualAudioDuration;
              return; // Don't do ANY updates during active playback
            }
            
            // Only update duration when NOT playing to avoid first-time pause issues
            const updatedRecording = {
              ...recording,
              duration: actualAudioDuration // Use audio's actual duration
            };
            
            // Safe to reload since we're not playing
            store.dispatch(loadRecordingAction(updatedRecording));
            console.log('✅ Duration updated safely during idle state');
          }
        }
        
        audioRef.current?.removeEventListener('loadedmetadata', handleAudioLoaded);
      };
      
      audioRef.current.addEventListener('loadedmetadata', handleAudioLoaded);
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
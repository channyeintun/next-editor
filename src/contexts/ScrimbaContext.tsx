import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba } from 'use-scrimba';
import { useAudioRecording } from '../hooks/useAudioRecording';
import { ScrimbaContext } from './ScrimbaContext';
import { createJsonStorage } from '../storage/JsonStorage';

let timeoutId: NodeJS.Timeout;

// Function to get audio duration from blob
const getAudioDuration = (audioBlob: Blob): Promise<number> => {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(audioBlob);
    
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (timeoutId) clearTimeout(timeoutId);
    };
    
    audio.onloadedmetadata = () => {
      cleanup();
      
      // Check for valid duration
      if (isFinite(audio.duration) && audio.duration > 0) {
        const durationMs = audio.duration * 1000; // Convert to milliseconds
        console.log('🎵 Audio duration detected:', durationMs, 'ms');
        resolve(durationMs);
      } else {
        console.warn('⚠️ Invalid audio duration:', audio.duration);
        reject(new Error('Invalid audio duration'));
      }
    };
    
    audio.onerror = () => {
      cleanup();
      reject(new Error('Failed to load audio metadata'));
    };
    
    // Timeout after 5 seconds
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Audio duration detection timeout'));
    }, 5000);
    
    audio.src = url;
  });
};


interface ScrimbaProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component that makes useScrimba functionality available to all child components
 * This replaces Redux state management with the useScrimba hook
 */
export const ScrimbaProvider: React.FC<ScrimbaProviderProps> = ({ children }) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioRecording = useAudioRecording();
  const jsonStorage = useRef(createJsonStorage());
  
  const originalScrimbaHook = useScrimba({
    editorRef,
    audioRef,
    onRecordingStart: () => {
      console.log('📹 Recording started');
      // Start audio recording asynchronously without blocking
      audioRecording.startRecording().catch((error) => {
        console.warn('Failed to start audio recording:', error);
        console.warn('This might be due to missing microphone permissions');
      });
    },
    onRecordingStop: async (recording) => {
      console.log('⏹️ Recording stopped', recording);
      console.log('🎤 Has audioBlob:', !!recording.audioBlob, recording.audioBlob ? `(${recording.audioBlob.size} bytes)` : '');
      originalScrimbaHook.loadRecording(recording);
    },
    onPlaybackStart: () => {
      console.log('▶️ Playback started');
    },
    onPlaybackPause: () => {
      console.log('⏸️ Playback paused');
    },
    onError: (error: Error) => {
      console.error('🚨 Scrimba error:', error);
    },
    pauseOnUserInteraction: true,
  });

  // Create custom stopRecording function that handles audio with Promise.allSettled()
  const stopRecordingWithAudio = async () => {
    console.log('🛑 Stopping both snapshot and audio recording simultaneously...');
    
    // Use Promise.allSettled() to ensure both recordings stop at exactly the same time
    const stopOperations = await Promise.allSettled([
      // Stop audio recording first to get the audio duration
      audioRecording.isRecordingAudio 
        ? audioRecording.stopRecording()
        : Promise.resolve(null),
      // Stop snapshot recording (will be adjusted to match audio duration)
      Promise.resolve('stopping-snapshots')
    ]);
    
    // Check results of stop operations
    const audioResult = stopOperations[0];
    const audioBlob = audioResult.status === 'fulfilled' ? audioResult.value : null;
    
    // Get master duration - ALWAYS use audio duration as master if available
    let masterDuration = 0;
    
    if (audioBlob) {
      try {
        masterDuration = await getAudioDuration(audioBlob);
        console.log('🎵 Audio duration is master:', masterDuration, 'ms');
      } catch (error) {
        console.warn('⚠️ Failed to get audio duration, falling back to snapshot duration',error);
        const currentRecording = originalScrimbaHook.getCurrentState?.()?.recording?.currentRecording;
        masterDuration = currentRecording?.duration || 0;
      }
    } else {
      // No audio, use snapshot duration
      const currentRecording = originalScrimbaHook.getCurrentState?.()?.recording?.currentRecording;
      masterDuration = currentRecording?.duration || 0;
    }
    
    // Ensure we have a valid duration
    if (!isFinite(masterDuration) || masterDuration <= 0) {
      console.warn('⚠️ Invalid master duration, setting to 0');
      masterDuration = 0;
    }
    
    if (audioBlob) {
      console.log('🎤 Audio recorded successfully:', audioBlob.size, 'bytes');
      console.log('🎵 MASTER DURATION (from audio):', masterDuration, 'ms');
    } else if (audioRecording.isRecordingAudio) {
      console.warn('🎤 Audio recording failed to stop properly');
    } else {
      console.log('🎤 No audio recording was active');
    }
    
    // Now stop snapshot recording and force it to use audio duration
    console.log('📸 Setting snapshot recording duration to match audio...');
    await originalScrimbaHook.stopRecording(audioBlob ? { audioBlob, masterDuration } : { masterDuration });
    
    console.log('✅ Both recordings now have identical duration:', masterDuration, 'ms');
  };

  // Create enhanced scrimba hook with audio-aware stopRecording and JSON storage methods
  const scrimbaHook = {
    ...originalScrimbaHook,
    stopRecording: stopRecordingWithAudio,
    // JSON Storage methods
    exportAsFile: jsonStorage.current.exportAsFile.bind(jsonStorage.current),
    exportAllAsFile: jsonStorage.current.exportAllAsFile.bind(jsonStorage.current),
    importFromFile: jsonStorage.current.importFromFile.bind(jsonStorage.current),
    clearStorage: jsonStorage.current.clear.bind(jsonStorage.current),
    getStorageStats: jsonStorage.current.getStats.bind(jsonStorage.current),
    deleteFromStorage: jsonStorage.current.delete.bind(jsonStorage.current),
    loadRecordingsFromStorage: async () => {
      try {
        const loadedRecordings = await jsonStorage.current.load();
        // Just return the recordings array - don't load them into the hook
        // The hook only handles one recording at a time for playback
        return loadedRecordings;
      } catch (error) {
        console.warn('Failed to load recordings from storage:', error);
        return [];
      }
    },
  };

  return (
    <ScrimbaContext value={{ ...scrimbaHook, editorRef, audioRef }}>
      {children}
    </ScrimbaContext>
  );
};


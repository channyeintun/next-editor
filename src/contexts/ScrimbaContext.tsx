import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba } from 'use-scrimba';
import { useAudioRecording } from '../hooks/useAudioRecording';
import { ScrimbaContext } from './ScrimbaContext';
import { createJsonStorage } from '../storage/JsonStorage';

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

  // Create custom stopRecording function that handles audio
  const stopRecordingWithAudio = async () => {
    if (audioRecording.isRecordingAudio) {
      console.log('🎤 Stopping audio recording...');
      const audioBlob = await audioRecording.stopRecording();
      if (audioBlob) {
        console.log('🎤 Audio recorded successfully:', audioBlob.size, 'bytes');
        originalScrimbaHook.stopRecording({ audioBlob });
      } else {
        console.warn('🎤 No audio blob received from recording');
        originalScrimbaHook.stopRecording();
      }
    } else {
      console.log('🎤 No audio recording was active');
      originalScrimbaHook.stopRecording();
    }
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


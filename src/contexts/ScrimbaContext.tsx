import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba } from '../use-scrimba/src';
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
  const jsonStorage = useRef(createJsonStorage());
  
  const originalScrimbaHook = useScrimba({
    editorRef,
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    onRecordingStart: () => {},
    onRecordingStop: (recording) => {
      originalScrimbaHook.loadRecording(recording);
    },
    onPlaybackStart: () => {},
    onPlaybackPause: () => {},
    onError: (error: Error) => {
      console.error('🚨 Scrimba error:', error);
    },
    pauseOnUserInteraction: true,
  });


  // Create enhanced scrimba hook with JSON storage methods
  const scrimbaHook = {
    ...originalScrimbaHook,
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
    <ScrimbaContext value={{ ...scrimbaHook, editorRef }}>
      {children}
    </ScrimbaContext>
  );
};


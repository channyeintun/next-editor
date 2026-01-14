import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba } from '../use-scrimba/src';
import { ScrimbaContext } from './ScrimbaContext';
import { createJsonStorage } from '../storage/JsonStorage';
import type { SlidePreviewState, PreviewState } from '../types/slides';

interface ScrimbaProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component that makes useScrimba functionality available to all child components
 */
export const ScrimbaProvider: React.FC<ScrimbaProviderProps> = ({ children }) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const jsonStorage = useRef(createJsonStorage());
  const getSlideStateRef = useRef<(() => { previewState: SlidePreviewState; currentSlideIndex: number } | null) | null>(null);
  const applySlideStateRef = useRef<((slideState: SlidePreviewState, currentSlideIndex: number) => void) | null>(null);
  const getSlidesRef = useRef<(() => Array<{id: string; imageUrl: string; name?: string; order: number}> | null) | null>(null);
  const applySlidesRef = useRef<((slides: Array<{id: string; imageUrl: string; name?: string; order: number}>) => void) | null>(null);
  const getPreviewStateRef = useRef<(() => PreviewState | null) | null>(null);
  const applyPreviewStateRef = useRef<((previewState: PreviewState) => void) | null>(null);
  
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
    getSlideState: () => getSlideStateRef.current?.() || null,
    applySlideState: (slideState, currentSlideIndex) => applySlideStateRef.current?.(slideState, currentSlideIndex),
    getSlides: () => getSlidesRef.current?.() || null,
    applySlides: (slides) => applySlidesRef.current?.(slides),
    getPreviewState: () => getPreviewStateRef.current?.() || null,
    applyPreviewState: (previewState) => applyPreviewStateRef.current?.(previewState),
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
    // Slide state registration
    registerSlideStateGetter: (getter: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null) => {
      getSlideStateRef.current = getter;
    },
    registerSlideStateApplier: (applier: (slideState: SlidePreviewState, currentSlideIndex: number) => void) => {
      applySlideStateRef.current = applier;
    },
    // Slides data registration
    registerSlidesGetter: (getter: () => Array<{id: string; imageUrl: string; name?: string; order: number}> | null) => {
      getSlidesRef.current = getter;
    },
    registerSlidesApplier: (applier: (slides: Array<{id: string; imageUrl: string; name?: string; order: number}>) => void) => {
      applySlidesRef.current = applier;
    },
    // Preview state registration
    registerPreviewStateGetter: (getter: () => PreviewState | null) => {
      getPreviewStateRef.current = getter;
    },
    registerPreviewStateApplier: (applier: (previewState: PreviewState) => void) => {
      applyPreviewStateRef.current = applier;
    },
  };

  return (
    <ScrimbaContext value={{ ...scrimbaHook, editorRef }}>
      {children}
    </ScrimbaContext>
  );
};


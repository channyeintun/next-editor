import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useNextEditor } from '../core/src';
import { NextEditorContext } from './NextEditorContext';
import { createJsonStorage } from '../storage/JsonStorage';
import type { SlidePreviewState, PreviewState, Slide } from '../types/slides';

interface NextEditorProviderProps {
  children: React.ReactNode;
}

export const NextEditorProvider: React.FC<NextEditorProviderProps> = ({ children }) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const jsonStorage = useRef(createJsonStorage());
  const getSlideStateRef = useRef<(() => { previewState: SlidePreviewState; currentSlideIndex: number } | null) | null>(null);
  const applySlideStateRef = useRef<((slideState: SlidePreviewState, currentSlideIndex: number) => void) | null>(null);

  const getPreviewStateRef = useRef<(() => PreviewState | null) | null>(null);
  const applyPreviewStateRef = useRef<((previewState: PreviewState) => void) | null>(null);

  const getSlidesRef = useRef<(() => Slide[]) | null>(null);
  const applySlidesRef = useRef<((slides: Slide[]) => void) | null>(null);

  const originalHook = useNextEditor({
    editorRef,
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    onRecordingStart: () => { },
    onRecordingStop: (recording) => {
      originalHook.loadRecording(recording);
    },
    onPlaybackStart: () => { },
    onPlaybackPause: () => { },
    onError: (error: Error) => {
      console.error('🚨 error:', error);
    },
    pauseOnUserInteraction: true,
    getSlideState: () => getSlideStateRef.current?.() || null,
    applySlideState: (slideState, currentSlideIndex) => applySlideStateRef.current?.(slideState, currentSlideIndex),

    getPreviewState: () => getPreviewStateRef.current?.() || null,
    applyPreviewState: (previewState) => applyPreviewStateRef.current?.(previewState),

    getSlides: () => getSlidesRef.current?.() || [],
    applySlides: (slides) => applySlidesRef.current?.(slides),
  });


  // Create enhanced hook with JSON storage methods
  const editorHook = {
    ...originalHook,
    // JSON Storage methods
    exportAsFile: jsonStorage.current.exportAsFile.bind(jsonStorage.current),
    exportAllAsFile: jsonStorage.current.exportAllAsFile.bind(jsonStorage.current),
    importFromFile: jsonStorage.current.importFromFile.bind(jsonStorage.current),
    clearStorage: jsonStorage.current.clear.bind(jsonStorage.current),
    getStorageStats: jsonStorage.current.getStats.bind(jsonStorage.current),
    deleteFromStorage: jsonStorage.current.delete.bind(jsonStorage.current),
    clearRecording: () => {
      originalHook.clearRecording();
      if (editorRef.current) {
        editorRef.current.setValue(`<html>
    <h1>Hello world</h1>
</html>`);
      }
    },
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
    registerSlidesGetter: (getter: () => Slide[]) => {
      getSlidesRef.current = getter;
    },
    registerSlidesApplier: (applier: (slides: Slide[]) => void) => {
      applySlidesRef.current = applier;
    },
    // Preview state registration
    registerPreviewStateGetter: (getter: () => PreviewState | null) => {
      getPreviewStateRef.current = getter;
    },
    registerPreviewStateApplier: (applier: (previewState: PreviewState) => void) => {
      applyPreviewStateRef.current = applier;
    },
    // Direct navigation channel
    registerSlideNavigator: (navigator: (indexh: number, indexv: number) => void) => {
      editorHook.navigateSlidesDirect = navigator;
    },
  };

  return (
    <NextEditorContext value={{ ...editorHook, editorRef }}>
      {children}
    </NextEditorContext>
  );
};


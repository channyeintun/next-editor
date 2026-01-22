import { useRef, useMemo, useCallback } from 'react';
import type * as monaco from 'monaco-editor';
import { useNextEditor, type Recording } from '../core/src';
import {
  NextEditorActionsContext,
  NextEditorMetadataContext,
  NextEditorPlaybackContext
} from './NextEditorContext';
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
  const navigateSlidesDirectRef = useRef<((indexh: number, indexv: number) => void) | null>(null);

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

  const {
    clearRecording: clearRecordingBase,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    isRecording,
    isRecordingAudio,
    isPlaying,
    isPaused,
    hasEnded,
    currentRecording,
    recordingStartTime,
    timelineActor,
    editorActor,
    playbackSpeed,
    volume,
    actualDuration,
  } = originalHook;

  // Stabilize storage and registration methods
  const exportAsFile = useCallback((recording: Recording, filename?: string) => jsonStorage.current.exportAsFile(recording, filename), []);
  const exportAllAsFile = useCallback((filename?: string) => jsonStorage.current.exportAllAsFile(filename), []);
  const importFromFile = useCallback(() => jsonStorage.current.importFromFile(), []);
  const clearStorage = useCallback(() => jsonStorage.current.clear(), []);
  const getStorageStats = useCallback(() => jsonStorage.current.getStats(), []);
  const deleteFromStorage = useCallback((id: string) => jsonStorage.current.delete(id), []);

  const loadRecordingsFromStorage = useCallback(async () => {
    try {
      return await jsonStorage.current.load();
    } catch (error) {
      console.warn('Failed to load recordings from storage:', error);
      return [];
    }
  }, []);

  const clearRecording = useCallback(() => {
    clearRecordingBase();
    if (editorRef.current) {
      editorRef.current.setValue(`<html>
  <h1>Hello world</h1>
</html>`);
    }
  }, [clearRecordingBase]);

  const registerSlideStateGetter = useCallback((getter: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null) => {
    getSlideStateRef.current = getter;
  }, []);

  const registerSlideStateApplier = useCallback((applier: (slideState: SlidePreviewState, currentSlideIndex: number) => void) => {
    applySlideStateRef.current = applier;
  }, []);

  const registerSlidesGetter = useCallback((getter: () => Slide[]) => {
    getSlidesRef.current = getter;
  }, []);

  const registerSlidesApplier = useCallback((applier: (slides: Slide[]) => void) => {
    applySlidesRef.current = applier;
  }, []);

  const registerPreviewStateGetter = useCallback((getter: () => PreviewState | null) => {
    getPreviewStateRef.current = getter;
  }, []);

  const registerPreviewStateApplier = useCallback((applier: (previewState: PreviewState) => void) => {
    applyPreviewStateRef.current = applier;
  }, []);

  const registerSlideNavigator = useCallback((navigator: (indexh: number, indexv: number) => void) => {
    navigateSlidesDirectRef.current = navigator;
  }, []);

  const navigateSlidesDirect = useCallback((indexh: number, indexv: number) => {
    navigateSlidesDirectRef.current?.(indexh, indexv);
  }, []);

  // 1. Memoize Stable Actions
  const actionsValue = useMemo(() => ({
    editorRef,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    clearRecording,
    exportAsFile,
    exportAllAsFile,
    importFromFile,
    clearStorage,
    getStorageStats,
    loadRecordingsFromStorage,
    deleteFromStorage,
    registerSlideStateGetter,
    registerSlideStateApplier,
    registerSlidesGetter,
    registerSlidesApplier,
    registerPreviewStateGetter,
    registerPreviewStateApplier,
    registerSlideNavigator,
    navigateSlidesDirect,
  }), [
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    navigateSlidesDirect,
    clearRecording,
    exportAsFile,
    exportAllAsFile,
    importFromFile,
    clearStorage,
    getStorageStats,
    loadRecordingsFromStorage,
    deleteFromStorage,
    registerSlideStateGetter,
    registerSlideStateApplier,
    registerSlidesGetter,
    registerSlidesApplier,
    registerPreviewStateGetter,
    registerPreviewStateApplier,
    registerSlideNavigator,
  ]);

  // 2. Memoize Metadata (flags)
  const metadataValue = useMemo(() => ({
    isRecording,
    isRecordingAudio,
    isPlaying,
    isPaused,
    hasEnded,
    currentRecording,
    recordingStartTime,
  }), [
    isRecording,
    isRecordingAudio,
    isPlaying,
    isPaused,
    hasEnded,
    currentRecording,
    recordingStartTime
  ]);

  // 3. Playback (Directly from hook to allow reactivity where needed)
  const playbackValue = useMemo(() => ({
    timelineActor,
    editorActor,
    playbackSpeed,
    volume,
    duration: actualDuration,
  }), [
    timelineActor,
    editorActor,
    playbackSpeed,
    volume,
    actualDuration,
  ]);

  return (
    <NextEditorActionsContext value={actionsValue}>
      <NextEditorMetadataContext value={metadataValue}>
        <NextEditorPlaybackContext value={playbackValue}>
          {children}
        </NextEditorPlaybackContext>
      </NextEditorMetadataContext>
    </NextEditorActionsContext>
  );
};


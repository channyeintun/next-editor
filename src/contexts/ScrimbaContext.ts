import { createContext, type RefObject } from 'react';
import type { UseScrimbaReturn, Recording } from '../use-scrimba/src';
import type { SlidePreviewState } from '../types/slides';
import type * as monaco from 'monaco-editor';

// Create context for useScrimba functionality with editor ref and JSON storage
export const ScrimbaContext = createContext<(UseScrimbaReturn & { 
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  // JSON Storage methods
  exportAsFile: (recording: Recording, filename?: string) => Promise<void>;
  exportAllAsFile: (filename?: string) => Promise<void>;
  importFromFile: () => Promise<Recording[]>;
  clearStorage: () => Promise<void>;
  getStorageStats: () => Promise<{ count: number; totalSize: string }>;
  loadRecordingsFromStorage: () => Promise<Recording[]>;
  deleteFromStorage: (id: string) => Promise<void>;
  // Slide state registration
  registerSlideStateGetter: (getter: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null) => void;
  registerSlideStateApplier: (applier: (slideState: SlidePreviewState, currentSlideIndex: number) => void) => void;
  // Slides data registration
  registerSlidesGetter: (getter: () => Array<{id: string; imageUrl: string; name?: string; order: number}> | null) => void;
  registerSlidesApplier: (applier: (slides: Array<{id: string; imageUrl: string; name?: string; order: number}>) => void) => void;
}) | null>(null);
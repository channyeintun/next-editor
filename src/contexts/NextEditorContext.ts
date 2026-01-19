import { createContext, type RefObject } from 'react';
import type { UseNextEditorReturn, Recording } from '../core/src';
import type { SlidePreviewState, PreviewState, Slide } from '../types/slides';
import type * as monaco from 'monaco-editor';

// Create context for useNextEditor functionality with editor ref and JSON storage
export const NextEditorContext = createContext<(UseNextEditorReturn & {
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
  registerSlidesGetter: (getter: () => Slide[]) => void;
  registerSlidesApplier: (applier: (slides: Slide[]) => void) => void;
  // Preview state registration
  registerPreviewStateGetter: (getter: () => PreviewState | null) => void;
  registerPreviewStateApplier: (applier: (previewState: PreviewState) => void) => void;
  // Slide navigation
  registerSlideNavigator: (navigator: (indexh: number, indexv: number) => void) => void;
  navigateSlidesDirect?: (indexh: number, indexv: number) => void;
}) | null>(null);
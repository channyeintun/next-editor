import { createContext, type RefObject } from 'react';
import type { UseScrimbaReturn, Recording } from '../use-scrimba/src';
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
}) | null>(null);
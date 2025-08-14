import { useContext, type RefObject } from 'react';
import type * as monaco from 'monaco-editor';
import { ScrimbaContext } from '../contexts/ScrimbaContext';
import type { UseScrimbaReturn, Recording } from '../use-scrimba/src';

/**
 * Hook to access useScrimba functionality from any component
 * This replaces useSelector and useDispatch from Redux and includes JSON storage methods
 */
export const useScrimbaContext = (): UseScrimbaReturn & { 
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  // JSON Storage methods
  exportAsFile: (recording: Recording, filename?: string) => Promise<void>;
  exportAllAsFile: (filename?: string) => Promise<void>;
  importFromFile: () => Promise<Recording[]>;
  clearStorage: () => Promise<void>;
  getStorageStats: () => Promise<{ count: number; totalSize: string }>;
  loadRecordingsFromStorage: () => Promise<Recording[]>;
  deleteFromStorage: (id: string) => Promise<void>;
} => {
  const context = useContext(ScrimbaContext);
  if (!context) {
    throw new Error('useScrimbaContext must be used within a ScrimbaProvider');
  }
  return context;
};
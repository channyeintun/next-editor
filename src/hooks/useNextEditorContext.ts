import { useContext, type RefObject } from 'react';
import type * as monaco from 'monaco-editor';
import { NextEditorContext } from '../contexts/NextEditorContext';
import type { UseNextEditorReturn, Recording } from '../core/src';

/**
 * Hook to access useNextEditor functionality from any component
 * This replaces useSelector and useDispatch from Redux and includes JSON storage methods
 */
export const useNextEditorContext = (): UseNextEditorReturn & {
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
  const context = useContext(NextEditorContext);
  if (!context) {
    throw new Error('useNextEditorContext must be used within a NextEditorProvider');
  }
  return context;
};
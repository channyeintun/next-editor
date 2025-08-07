import { useContext, type RefObject } from 'react';
import type * as monaco from 'monaco-editor';
import { ScrimbaContext } from '../contexts/ScrimbaContext';
import type { UseScrimbaReturn } from 'use-scrimba';

/**
 * Hook to access useScrimba functionality from any component
 * This replaces useSelector and useDispatch from Redux
 */
export const useScrimbaContext = (): UseScrimbaReturn & { 
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null> 
} => {
  const context = useContext(ScrimbaContext);
  if (!context) {
    throw new Error('useScrimbaContext must be used within a ScrimbaProvider');
  }
  return context;
};
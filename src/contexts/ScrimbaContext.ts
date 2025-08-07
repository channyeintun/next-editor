import { createContext, type RefObject } from 'react';
import type { UseScrimbaReturn } from 'use-scrimba';
import type * as monaco from 'monaco-editor';

// Create context for useScrimba functionality with editor ref
export const ScrimbaContext = createContext<(UseScrimbaReturn & { 
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null> 
}) | null>(null);
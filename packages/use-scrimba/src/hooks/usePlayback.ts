import { useEffect } from 'react';
import type * as monaco from 'monaco-editor';
import type { EditorState } from '../types';

/**
 * Internal hook for handling Monaco Editor playback functionality
 */
export const usePlayback = (
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>,
  isPlaying: boolean,
  editorState: EditorState,
  pauseOnUserInteraction: boolean = true,
  onPause?: () => void
) => {
  // Setup user interaction listeners during playback
  useEffect(() => {
    if (isPlaying && pauseOnUserInteraction && editorRef.current) {
      const editor = editorRef.current;
      const disposables: monaco.IDisposable[] = [];
      
      // Listen for user mouse clicks during replay
      disposables.push(
        editor.onMouseDown(() => {
          onPause?.();
        })
      );
      
      // Listen for user keyboard input during replay
      disposables.push(
        editor.onKeyDown(() => {
          onPause?.();
        })
      );
      
      return () => {
        disposables.forEach(d => d.dispose());
      };
    }
  }, [isPlaying, pauseOnUserInteraction, editorRef, onPause]);

  // Prevent content changes during replay by reverting user modifications
  useEffect(() => {
    if (isPlaying && editorRef.current) {
      const editor = editorRef.current;
      
      // Intercept content changes during replay and revert them
      const contentDisposable = editor.onDidChangeModelContent(() => {
        if (isPlaying) {
          // Revert any user changes during replay
          const currentContent = editor.getValue();
          if (currentContent !== editorState.content) {
            editor.setValue(editorState.content);
            editor.setPosition(editorState.position);
            editor.setSelection(editorState.selection);
          }
        }
      });
      
      return () => {
        contentDisposable.dispose();
      };
    }
  }, [isPlaying, editorState, editorRef]);

  // Apply replay state to editor
  useEffect(() => {
    if (editorRef.current && isPlaying) {
      const editor = editorRef.current;
      
      // Update content if different
      if (editor.getValue() !== editorState.content) {
        editor.setValue(editorState.content);
      }
      
      // Update cursor position
      editor.setPosition(editorState.position);
      
      // Update selection
      editor.setSelection(editorState.selection);
      
      // Force cursor visibility during replay
      editor.focus();
      
      // Restore full view state if available
      if (editorState.viewState) {
        editor.restoreViewState(editorState.viewState);
      }
    }
  }, [editorState, isPlaying, editorRef]);

  // Helper functions for external use
  const getEditorState = (): EditorState | null => {
    if (!editorRef.current) return null;
    
    const editor = editorRef.current;
    const content = editor.getValue();
    const selection = editor.getSelection();
    const position = editor.getPosition();
    const viewState = editor.saveViewState();

    if (!selection || !position) return null;

    return {
      content,
      selection,
      position,
      viewState,
    };
  };

  const applyEditorState = (state: EditorState) => {
    if (!editorRef.current) return;
    
    const editor = editorRef.current;
    editor.setValue(state.content);
    editor.setPosition(state.position);
    editor.setSelection(state.selection);
    
    if (state.viewState) {
      editor.restoreViewState(state.viewState);
    }
  };

  return {
    getEditorState,
    applyEditorState,
  };
};
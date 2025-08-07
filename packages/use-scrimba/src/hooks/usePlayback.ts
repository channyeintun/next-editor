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

  // Apply replay state to editor immediately
  useEffect(() => {
    if (editorRef.current && isPlaying) {
      const editor = editorRef.current;
      
      try {
        const model = editor.getModel();
        if (!model) return;
        
        // Update content if different - do this atomically
        const currentContent = editor.getValue();
        if (currentContent !== editorState.content) {
          try {
            editor.setValue(editorState.content);
          } catch (error) {
            console.warn('Error setting editor content:', error);
            return;
          }
        }
        
        // Apply position and selection immediately after content
        try {
          const updatedModel = editor.getModel();
          if (!updatedModel) return;
          
          // Validate position is within bounds
          const lineCount = updatedModel.getLineCount();
          if (lineCount === 0) return;
          
          const safeLineNumber = Math.min(Math.max(editorState.position.lineNumber, 1), lineCount);
          const maxColumn = Math.max(1, updatedModel.getLineLength(safeLineNumber) + 1);
          const validPosition = {
            lineNumber: safeLineNumber,
            column: Math.min(Math.max(editorState.position.column, 1), maxColumn)
          };
          
          // Update cursor position safely
          editor.setPosition(validPosition);
          
          // Validate and update selection safely
          const startLine = Math.min(Math.max(editorState.selection.startLineNumber, 1), lineCount);
          const endLine = Math.min(Math.max(editorState.selection.endLineNumber, 1), lineCount);
          const startMaxColumn = Math.max(1, updatedModel.getLineLength(startLine) + 1);
          const endMaxColumn = Math.max(1, updatedModel.getLineLength(endLine) + 1);
          
          const validSelection = {
            startLineNumber: startLine,
            startColumn: Math.min(Math.max(editorState.selection.startColumn, 1), startMaxColumn),
            endLineNumber: endLine,
            endColumn: Math.min(Math.max(editorState.selection.endColumn, 1), endMaxColumn)
          };
          
          editor.setSelection(validSelection);
          
          // Force cursor visibility during replay
          editor.focus();
        } catch (error) {
          console.warn('Error setting editor position/selection:', error);
        }
        
        // Restore view state last
        if (editorState.viewState) {
          try {
            editor.restoreViewState(editorState.viewState);
          } catch (error) {
            console.warn('Error restoring view state:', error);
          }
        }
      } catch (error) {
        console.warn('Error applying editor state:', error);
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
    
    try {
      const model = editor.getModel();
      if (!model) return;
      
      // Set content atomically
      try {
        editor.setValue(state.content);
      } catch (error) {
        console.warn('Error setting editor content in applyEditorState:', error);
        return;
      }
      
      // Apply position and selection immediately
      try {
        const updatedModel = editor.getModel();
        if (!updatedModel) return;
        
        // Validate position is within bounds
        const lineCount = updatedModel.getLineCount();
        if (lineCount === 0) return;
        
        const safeLineNumber = Math.min(Math.max(state.position.lineNumber, 1), lineCount);
        const maxColumn = Math.max(1, updatedModel.getLineLength(safeLineNumber) + 1);
        const validPosition = {
          lineNumber: safeLineNumber,
          column: Math.min(Math.max(state.position.column, 1), maxColumn)
        };
        
        // Update cursor position safely
        editor.setPosition(validPosition);
        
        // Validate and update selection safely
        const startLine = Math.min(Math.max(state.selection.startLineNumber, 1), lineCount);
        const endLine = Math.min(Math.max(state.selection.endLineNumber, 1), lineCount);
        const startMaxColumn = Math.max(1, updatedModel.getLineLength(startLine) + 1);
        const endMaxColumn = Math.max(1, updatedModel.getLineLength(endLine) + 1);
        
        const validSelection = {
          startLineNumber: startLine,
          startColumn: Math.min(Math.max(state.selection.startColumn, 1), startMaxColumn),
          endLineNumber: endLine,
          endColumn: Math.min(Math.max(state.selection.endColumn, 1), endMaxColumn)
        };
        
        editor.setSelection(validSelection);
      } catch (error) {
        console.warn('Error setting editor position/selection in applyEditorState:', error);
      }
      
      // Restore view state last
      if (state.viewState) {
        try {
          editor.restoreViewState(state.viewState);
        } catch (error) {
          console.warn('Error restoring view state in applyEditorState:', error);
        }
      }
    } catch (error) {
      console.warn('Error applying editor state:', error);
    }
  };

  return {
    getEditorState,
    applyEditorState,
  };
};
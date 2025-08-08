import { useEffect } from 'react';
import type * as monaco from 'monaco-editor';
import type { EditorState } from '../types';
import { isValidEditorState, isEditorReady } from '../utils/validation';
import { applyContentDiff } from '../utils/editorDiff';

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
            applyContentDiff(editor, editorState.content);
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

  // Apply replay state to editor during playback only
  useEffect(() => {
    if (editorRef.current && isPlaying) {
      const editor = editorRef.current;
      
      // Check if editor is fully ready before any operations
      if (!isEditorReady(editor)) {
        console.warn('Editor not ready during playback, skipping state application');
        return;
      }
      
      // Validate editor state before any operations
      if (!isValidEditorState(editorState)) {
        console.warn('Invalid editor state during playback:', editorState);
        return;
      }
      
      try {
        const model = editor.getModel();
        if (!model) return;
        
        // Always update content first
        const currentContent = editor.getValue();
        if (currentContent !== editorState.content) {
          try {
            applyContentDiff(editor, editorState.content);
          } catch (error) {
            console.warn('Error setting editor content during playback:', error);
            return;
          }
        }
        
        // Only apply position/selection if content matches (editor is stable)
        if (editor.getValue() === editorState.content) {
          try {
            const updatedModel = editor.getModel();
            if (!updatedModel) return;
            
            const lineCount = updatedModel.getLineCount();
            if (lineCount === 0) return;
            
            // Validate and apply position
            const safeLineNumber = Math.min(Math.max(editorState.position.lineNumber, 1), lineCount);
            const lineLength = updatedModel.getLineLength(safeLineNumber);
            
            if (lineLength >= 0) {
              const maxColumn = Math.max(1, lineLength + 1);
              const validPosition = {
                lineNumber: safeLineNumber,
                column: Math.min(Math.max(editorState.position.column, 1), maxColumn)
              };
              editor.setPosition(validPosition);
              
              // Validate and apply selection
              const startLine = Math.min(Math.max(editorState.selection.startLineNumber, 1), lineCount);
              const endLine = Math.min(Math.max(editorState.selection.endLineNumber, 1), lineCount);
              const startLineLength = updatedModel.getLineLength(startLine);
              const endLineLength = updatedModel.getLineLength(endLine);
              
              if (startLineLength >= 0 && endLineLength >= 0) {
                const startMaxColumn = Math.max(1, startLineLength + 1);
                const endMaxColumn = Math.max(1, endLineLength + 1);
                
                const validSelection = {
                  startLineNumber: startLine,
                  startColumn: Math.min(Math.max(editorState.selection.startColumn, 1), startMaxColumn),
                  endLineNumber: endLine,
                  endColumn: Math.min(Math.max(editorState.selection.endColumn, 1), endMaxColumn)
                };
                editor.setSelection(validSelection);
              }
              
              // Force cursor visibility during replay
              editor.focus();
            }
          } catch (error) {
            console.warn('Error setting editor position/selection during playback:', error);
          }
          
          // Restore view state only when editor is fully stable
          if (editorState.viewState) {
            try {
              editor.restoreViewState(editorState.viewState);
            } catch (error) {
              console.warn('Error restoring view state during playback:', error);
            }
          }
        }
      } catch (error) {
        console.warn('Error applying editor state during playback:', error);
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
    
    // Check if editor is ready before any operations
    if (!isEditorReady(editor)) {
      console.warn('Editor not ready in applyEditorState, skipping');
      return;
    }
    
    // Validate state structure
    if (!isValidEditorState(state)) {
      console.warn('Invalid state passed to applyEditorState:', state);
      return;
    }
    
    const model = editor.getModel();
    if (!model) return;
    
    // Skip if content is the same to avoid triggering Monaco's internal events
    try {
      applyContentDiff(editor, state.content);
    } catch (error) {
      console.warn('Failed to set editor content:', error);
      return;
    }
    
    // Get the updated model reference after content change
    const updatedModel = editor.getModel();
    if (!updatedModel) return;
    
    // Validate model is ready for position operations
    const lineCount = updatedModel.getLineCount();
    if (lineCount === 0) return;
    
    // Only proceed if we have valid line/column data
    try {
      const safeLineNumber = Math.min(Math.max(state.position.lineNumber, 1), lineCount);
      const lineLength = updatedModel.getLineLength(safeLineNumber);
      
      // Skip position update if line doesn't exist yet
      if (lineLength < 0) {
        console.warn(`Line ${safeLineNumber} does not exist in model (lineCount: ${lineCount})`);
        return;
      }
      
      const maxColumn = Math.max(1, lineLength + 1);
      const validPosition = {
        lineNumber: safeLineNumber,
        column: Math.min(Math.max(state.position.column, 1), maxColumn)
      };
      
      editor.setPosition(validPosition);
      
      // Validate selection bounds
      const startLine = Math.min(Math.max(state.selection.startLineNumber, 1), lineCount);
      const endLine = Math.min(Math.max(state.selection.endLineNumber, 1), lineCount);
      const startLineLength = updatedModel.getLineLength(startLine);
      const endLineLength = updatedModel.getLineLength(endLine);
      
      // Skip selection if lines don't exist yet
      if (startLineLength < 0 || endLineLength < 0) {
        console.warn(`Selection lines don't exist - start: ${startLine} (${startLineLength}), end: ${endLine} (${endLineLength})`);
        return;
      }
      
      const startMaxColumn = Math.max(1, startLineLength + 1);
      const endMaxColumn = Math.max(1, endLineLength + 1);
      
      const validSelection = {
        startLineNumber: startLine,
        startColumn: Math.min(Math.max(state.selection.startColumn, 1), startMaxColumn),
        endLineNumber: endLine,
        endColumn: Math.min(Math.max(state.selection.endColumn, 1), endMaxColumn)
      };
      
      editor.setSelection(validSelection);
      
      // Only restore view state if the editor is in a stable state
      if (state.viewState && editor.getValue() === state.content) {
        try {
          editor.restoreViewState(state.viewState);
        } catch (error) {
          console.warn('Failed to restore view state:', error);
        }
      }
    } catch (error) {
      console.warn('Failed to apply editor position/selection:', error);
      return;
    }
  };

  return {
    getEditorState,
    applyEditorState,
  };
};
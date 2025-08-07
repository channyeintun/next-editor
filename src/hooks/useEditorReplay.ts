import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import type * as monaco from 'monaco-editor';
import { pause } from '../store/slices/replaySlice';

/**
 * Custom hook for handling Monaco Editor replay functionality
 * 
 * This hook manages:
 * - Applying replay state to the editor (content, position, selection, viewState)
 * - User interaction detection during replay (pause on interaction)
 * - Content change prevention during replay
 * - Cursor visibility during replay
 * 
 * @param editorRef - Reference to the Monaco Editor instance
 * @param isPlaying - Whether replay is currently active
 * @param editorState - Current editor state from replay slice
 */
export const useEditorReplay = (
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>,
  isPlaying: boolean,
  editorState: {
    content: string;
    selection: monaco.Selection;
    position: monaco.Position;
    viewState: monaco.editor.ICodeEditorViewState | null;
  }
) => {
  const dispatch = useDispatch();

  // Setup user interaction listeners during replay
  useEffect(() => {
    if (isPlaying && editorRef.current) {
      const editor = editorRef.current;
      
      // Listen for user mouse clicks during replay
      const mouseDisposable = editor.onMouseDown(() => {
        console.log('User clicked in editor during replay - pausing');
        dispatch(pause());
      });
      
      // Listen for user keyboard input during replay
      const keyDisposable = editor.onKeyDown(() => {
        console.log('User pressed key in editor during replay - pausing');
        dispatch(pause());
      });
      
      return () => {
        mouseDisposable.dispose();
        keyDisposable.dispose();
      };
    }
  }, [isPlaying, dispatch, editorRef]);

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
      
      console.log('position', editorState.position);
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
};
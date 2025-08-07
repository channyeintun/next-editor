import { useEffect, useCallback, useState } from 'react';
import { useDispatch } from 'react-redux';
import type * as monaco from 'monaco-editor';
import { addSnapshot } from '../store/slices/recordingSlice';

/**
 * Custom hook for handling Monaco Editor recording functionality
 * 
 * This hook manages:
 * - Recording state changes (content, cursor position, selection, scroll)
 * - Event listeners during recording
 * - Snapshot creation with precise timestamps
 * 
 * @param editorRef - Reference to the Monaco Editor instance
 * @param isRecording - Whether recording is currently active
 * @param isPlaying - Whether replay is currently active
 */
export const useEditorRecording = (
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>,
  isRecording: boolean,
  isPlaying: boolean
) => {
  const dispatch = useDispatch();
  const [stateChangeCounter, setStateChangeCounter] = useState(0);

  // Function to trigger state change capture
  const triggerStateChange = useCallback(() => {
    if (isRecording && !isPlaying) {
      setStateChangeCounter(prev => prev + 1);
    }
  }, [isRecording, isPlaying]);

  // Handle editor content changes
  const handleEditorChange = useCallback(() => {
    console.log('onChange triggered');
    triggerStateChange();
  }, [triggerStateChange]);

  // Create snapshots when state changes occur
  useEffect(() => {
    if (isRecording && !isPlaying && editorRef.current && stateChangeCounter > 0) {
      const editor = editorRef.current;
      const content = editor.getValue();
      const selection = editor.getSelection();
      const position = editor.getPosition();
      const viewState = editor.saveViewState();

      console.log('Creating snapshot at exact timestamp:', {
        stateChangeCounter,
        content: content.substring(0, 50) + (content.length > 50 ? '...' : ''),
        selection,
        position,
        viewState
      });
      
      if (selection && position && viewState) {
        dispatch(addSnapshot({
          state: {
            content,
            selection,
            position,
            viewState,
          }
        }));
      }
    }
  }, [stateChangeCounter, isRecording, isPlaying, dispatch, editorRef]);

  // Reset state change counter when recording starts
  useEffect(() => {
    if (isRecording && !isPlaying) {
      setStateChangeCounter(0);
    }
  }, [isRecording, isPlaying]);

  // Setup event listeners for recording
  useEffect(() => {
    if (isRecording && !isPlaying && editorRef.current) {
      const editor = editorRef.current;
      
      // Listen to cursor position changes
      const positionDisposable = editor.onDidChangeCursorPosition(() => {
        console.log('Cursor position changed');
        triggerStateChange();
      });
      
      // Listen to cursor/selection changes
      const selectionDisposable = editor.onDidChangeCursorSelection(() => {
        console.log('Selection changed');
        triggerStateChange();
      });
      
      // Listen to scroll changes
      const scrollDisposable = editor.onDidScrollChange(() => {
        console.log('Scroll changed');
        triggerStateChange();
      });
      
      return () => {
        positionDisposable.dispose();
        selectionDisposable.dispose();
        scrollDisposable.dispose();
      };
    }
  }, [isRecording, isPlaying, triggerStateChange, editorRef]);

  return {
    handleEditorChange
  };
};
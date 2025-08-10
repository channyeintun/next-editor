import { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import type * as monaco from 'monaco-editor';
import type { EditorSnapshot, CaptureEvents, MouseCursorPosition } from '../types';

/**
 * Internal hook for handling Monaco Editor recording functionality
 */
export const useRecording = (
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>,
  isRecording: boolean,
  isPlaying: boolean,
  captureEvents: CaptureEvents = {},
  onSnapshot?: (snapshot: EditorSnapshot) => void
) => {
  const [stateChangeCounter, setStateChangeCounter] = useState(0);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const currentMouseCursor = useRef<MouseCursorPosition>({ x: 0, y: 0, visible: false });

  // Default capture settings (memoized to prevent dependency changes)
  const settings = useMemo(() => ({
    content: true,
    cursorPosition: true,
    selection: true,
    scroll: true,
    mouseCursor: true,
    ...captureEvents,
  }), [captureEvents]);

  // Function to trigger state change capture
  const triggerStateChange = useCallback(() => {
    if (isRecording && !isPlaying) {
      setStateChangeCounter(prev => prev + 1);
    }
  }, [isRecording, isPlaying]);

  // Handle editor content changes
  const handleEditorChange = useCallback(() => {
    if (settings.content) {
      triggerStateChange();
    }
  }, [triggerStateChange, settings.content]);

  // Create snapshots when state changes occur
  useEffect(() => {
    if (isRecording && !isPlaying && editorRef.current && stateChangeCounter > 0 && recordingStartTime) {
      const editor = editorRef.current;
      const content = editor.getValue();
      const selection = editor.getSelection();
      const position = editor.getPosition();
      const viewState = editor.saveViewState();

      if (selection && position && viewState) {
        const snapshot: EditorSnapshot = {
          timestamp: Date.now() - recordingStartTime,
          state: {
            content,
            selection,
            position,
            viewState,
            mouseCursor: settings.mouseCursor ? { ...currentMouseCursor.current } : undefined,
          }
        };

        onSnapshot?.(snapshot);
      }
    }
  }, [stateChangeCounter, isRecording, isPlaying, editorRef, recordingStartTime, onSnapshot, settings.mouseCursor]);

  // Reset state change counter when recording starts
  useEffect(() => {
    if (isRecording && !isPlaying) {
      setStateChangeCounter(0);
      setRecordingStartTime(Date.now());
    } else if (!isRecording) {
      setRecordingStartTime(null);
    }
  }, [isRecording, isPlaying]);

  // Setup event listeners for recording
  useEffect(() => {
    if (isRecording && !isPlaying && editorRef.current) {
      const editor = editorRef.current;
      const disposables: monaco.IDisposable[] = [];
      
      if (settings.cursorPosition) {
        disposables.push(
          editor.onDidChangeCursorPosition(() => {
            triggerStateChange();
          })
        );
      }
      
      if (settings.selection) {
        disposables.push(
          editor.onDidChangeCursorSelection(() => {
            triggerStateChange();
          })
        );
      }
      
      if (settings.scroll) {
        disposables.push(
          editor.onDidScrollChange(() => {
            triggerStateChange();
          })
        );
      }
      
      // Mouse cursor tracking
      if (settings.mouseCursor) {
        const editorDomNode = editor.getDomNode();
        if (editorDomNode) {
          const handleMouseMove = (event: MouseEvent) => {
            // Record viewport coordinates, not editor-relative coordinates
            currentMouseCursor.current = {
              x: event.clientX,
              y: event.clientY,
              visible: true
            };
            triggerStateChange();
          };

          const handleMouseEnter = () => {
            currentMouseCursor.current.visible = true;
          };

          const handleMouseLeave = () => {
            currentMouseCursor.current.visible = false;
            triggerStateChange();
          };

          editorDomNode.addEventListener('mousemove', handleMouseMove);
          editorDomNode.addEventListener('mouseenter', handleMouseEnter);
          editorDomNode.addEventListener('mouseleave', handleMouseLeave);

          return () => {
            disposables.forEach(d => d.dispose());
            editorDomNode.removeEventListener('mousemove', handleMouseMove);
            editorDomNode.removeEventListener('mouseenter', handleMouseEnter);
            editorDomNode.removeEventListener('mouseleave', handleMouseLeave);
          };
        }
      }
      
      return () => {
        disposables.forEach(d => d.dispose());
      };
    }
  }, [isRecording, isPlaying, triggerStateChange, editorRef, settings]);

  return {
    handleEditorChange,
    recordingStartTime,
  };
};
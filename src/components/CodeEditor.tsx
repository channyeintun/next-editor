import React, { useRef, useEffect } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';
import { useDispatch, useSelector } from 'react-redux';
import type * as monaco from 'monaco-editor';
import type { RootState } from '../store';
import { addSnapshot } from '../store/slices/recordingSlice';
import { pause } from '../store/slices/replaySlice';

interface CodeEditorProps {
  language?: string;
  theme?: string;
  height?: string;
}

const CodeEditor: React.FC<CodeEditorProps> = ({
  language = 'javascript',
  theme = 'vs-dark',
  height = '600px'
}) => {
  const dispatch = useDispatch();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const programmaticFocusRef = useRef(false);
  const { isRecording } = useSelector((state: RootState) => state.recording);
  const { isPlaying, editorState } = useSelector((state: RootState) => state.replay);

  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };
  
  const handleEditorChange: OnChange = () => {
    console.log('onChange triggered');
    triggerStateChange();
  };
  
  // State to trigger useEffect when changes occur
  const [stateChangeCounter, setStateChangeCounter] = React.useState(0);
  
  // Function to trigger state change
  const triggerStateChange = React.useCallback(() => {
    if (isRecording && !isPlaying) {
      setStateChangeCounter(prev => prev + 1);
    }
  }, [isRecording, isPlaying]);
  
  // useEffect to create snapshots with exact timestamps when state changes
  useEffect(() => {
    if (isRecording && !isPlaying && editorRef.current && stateChangeCounter > 0) {
      const editor = editorRef.current;
      const content = editor.getValue();
      console.log('editor',editor);
      console.log('content',content);
      const selection = editor.getSelection();
      const position = editor.getPosition();
      console.log('position', position);
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
  }, [stateChangeCounter, isRecording, isPlaying, dispatch]);
  
  // Reset state change counter when recording starts
  useEffect(() => {
    if (isRecording && !isPlaying) {
      setStateChangeCounter(0);
    }
  }, [isRecording, isPlaying]);
  
  // Also capture selection and scroll changes
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
  }, [isRecording, isPlaying, triggerStateChange]);
  
  // Add focus listener during replay to pause when user interacts
  useEffect(() => {
    if (isPlaying && editorRef.current) {
      const editor = editorRef.current;
      
      // Listen for user interactions during replay
      const mouseDisposable = editor.onMouseDown(() => {
        console.log('User clicked in editor during replay - pausing');
        dispatch(pause());
      });
      
      const keyDisposable = editor.onKeyDown(() => {
        console.log('User pressed key in editor during replay - pausing');
        dispatch(pause());
      });
      
      return () => {
        mouseDisposable.dispose();
        keyDisposable.dispose();
      };
    }
  }, [isPlaying, dispatch]);
  
  // Prevent content changes during replay
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
  }, [isPlaying, editorState, dispatch]);
  
  // Apply replay state to editor
  useEffect(() => {
    if (editorRef.current && isPlaying) {
      const editor = editorRef.current;
      
      // Update content
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
  }, [editorState, isPlaying]);
  
  return (
    <Editor
      height={height}
      language={language}
      theme={theme}
      value={isPlaying ? editorState.content : undefined}
      onMount={handleEditorDidMount}
      onChange={handleEditorChange}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        lineNumbers: 'on',
        roundedSelection: false,
        scrollBeyondLastLine: false,
        readOnly: false, // Keep editor writable to allow cursor blinking
        cursorStyle: 'line',
        cursorBlinking: 'blink',
        renderValidationDecorations: 'on',
        automaticLayout: true,
        // Disable code suggestions and IntelliSense
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        acceptSuggestionOnEnter: 'off',
        tabCompletion: 'off',
        wordBasedSuggestions: 'off',
        parameterHints: { enabled: false },
        hover: { enabled: false },
        contextmenu: false,
        // Disable other distracting features
        folding: false,
        foldingHighlight: false,
        unfoldOnClickAfterEndOfLine: false,
        showUnused: false,
        occurrencesHighlight: 'off',
        selectionHighlight: false,
        renderLineHighlight: 'none',
      }}
    />
  );
};

export default CodeEditor;
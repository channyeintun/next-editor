import React, { useRef, useEffect } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';
import { useDispatch, useSelector } from 'react-redux';
import type * as monaco from 'monaco-editor';
import type { RootState } from '../store';
import { addSnapshot } from '../store/slices/recordingSlice';

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
      const viewState = editor.saveViewState();
      
      console.log('Creating snapshot at exact timestamp:', {
        stateChangeCounter,
        content: content.substring(0, 50) + (content.length > 50 ? '...' : ''),
        selection,
        viewState
      });
      
      if (selection && viewState) {
        dispatch(addSnapshot({
          state: {
            content,
            selection,
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
        selectionDisposable.dispose();
        scrollDisposable.dispose();
      };
    }
  }, [isRecording, isPlaying, triggerStateChange]);
  
  // Apply replay state to editor
  useEffect(() => {
    if (editorRef.current && isPlaying) {
      const editor = editorRef.current;
      
      // Update content
      if (editor.getValue() !== editorState.content) {
        editor.setValue(editorState.content);
      }
      
      // Update selection
      editor.setSelection(editorState.selection);
      
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
        readOnly: isPlaying, // Make editor read-only during replay
        cursorStyle: 'line',
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
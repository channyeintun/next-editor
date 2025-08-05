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
  const recordingIntervalRef = useRef<number | null>(null);
  const { isRecording } = useSelector((state: RootState) => state.recording);
  const { isPlaying, editorState } = useSelector((state: RootState) => state.replay);

  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };
  
  const handleEditorChange: OnChange = () => {
    // Recording handled by interval
  };
  
  // Interval-based recording with minimal interval
  useEffect(() => {
    if (isRecording && !isPlaying && editorRef.current) {
      recordingIntervalRef.current = setInterval(() => {
        const editor = editorRef.current;
        if (editor) {
          const content = editor.getValue();
          const selection = editor.getSelection();
          const viewState = editor.saveViewState();
          
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
      }, 16); // ~60fps - minimal interval for smooth recording
      
      return () => {
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
        }
      };
    } else {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
    }
  }, [isRecording, isPlaying, dispatch]);
  
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
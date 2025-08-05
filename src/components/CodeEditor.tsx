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
  const lastRecordedStateRef = useRef<{
    content: string;
    selection: monaco.Selection | null;
    viewState: monaco.editor.ICodeEditorViewState | null;
  } | null>(null);
  const { isRecording } = useSelector((state: RootState) => state.recording);
  const { isPlaying, editorState } = useSelector((state: RootState) => state.replay);

  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };
  
  const handleEditorChange: OnChange = () => {
    // State change recording handled by useEffect
  };
  
  // State-change-based recording - only record when editor state actually changes
  const recordStateChange = React.useCallback(() => {
    if (isRecording && !isPlaying && editorRef.current) {
      const editor = editorRef.current;
      const content = editor.getValue();
      const selection = editor.getSelection();
      const viewState = editor.saveViewState();
      
      // Check if state has actually changed
      const currentState = {
        content,
        selection,
        viewState,
      };
      
      const lastState = lastRecordedStateRef.current;
      const hasChanged = !lastState || 
        lastState.content !== content ||
        !lastState.selection ||
        !selection ||
        lastState.selection.startLineNumber !== selection.startLineNumber ||
        lastState.selection.startColumn !== selection.startColumn ||
        lastState.selection.endLineNumber !== selection.endLineNumber ||
        lastState.selection.endColumn !== selection.endColumn;
      
      if (hasChanged && selection && viewState) {
        dispatch(addSnapshot({
          state: {
            content,
            selection,
            viewState,
          }
        }));
        
        // Update the last recorded state
        lastRecordedStateRef.current = currentState;
      }
    }
  }, [isRecording, isPlaying, dispatch]);
  
  // Set up Monaco editor change listeners for recording
  useEffect(() => {
    if (isRecording && !isPlaying && editorRef.current) {
      const editor = editorRef.current;
      
      // Listen to content changes
      const contentDisposable = editor.onDidChangeModelContent(() => {
        recordStateChange();
      });
      
      // Listen to cursor/selection changes
      const selectionDisposable = editor.onDidChangeCursorSelection(() => {
        recordStateChange();
      });
      
      // Listen to view state changes (scroll, etc.)
      const scrollDisposable = editor.onDidScrollChange(() => {
        recordStateChange();
      });
      
      // Record initial state when recording starts
      recordStateChange();
      
      return () => {
        contentDisposable.dispose();
        selectionDisposable.dispose();
        scrollDisposable.dispose();
      };
    }
  }, [isRecording, isPlaying, recordStateChange]);
  
  // Reset last recorded state when recording starts
  useEffect(() => {
    if (isRecording && !isPlaying) {
      lastRecordedStateRef.current = null;
    }
  }, [isRecording, isPlaying]);
  
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
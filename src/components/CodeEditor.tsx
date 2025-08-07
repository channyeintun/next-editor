import React from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';

interface CodeEditorProps {
  language?: string;
  theme?: string;
  height?: string;
}

/**
 * CodeEditor Component - Monaco Editor wrapper with recording and replay capabilities
 * 
 * Features:
 * - Records all editor state changes (content, cursor position, selection, scroll) with timestamps
 * - Replays recorded sessions with synchronized cursor movement and content changes
 * - Pauses replay on user interaction (mouse click or keyboard input)
 * - Maintains cursor visibility during replay while preventing content modifications
 * 
 * @param language - Programming language for syntax highlighting (default: 'javascript')
 * @param theme - Monaco editor theme (default: 'vs-dark')
 * @param height - Editor height (default: '600px')
 */

const CodeEditor: React.FC<CodeEditorProps> = ({
  language = 'javascript',
  theme = 'vs-dark',
  height = '600px'
}) => {
  // Use the useScrimba context instead of Redux and custom hooks
  const { handleEditorMount, handleEditorChange, editorRef } = useScrimbaContext();

  /**
   * Handle Monaco Editor mount event
   * Sets up the editor reference for use in recording and replay
   */
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
    handleEditorMount(editor);
  };
  
  return (
    <Editor
      height={height}
      language={language}
      theme={theme}
      defaultValue="// 🎬 Scrimba-like Recording Demo
// Use the media controls to record and replay your coding sessions!

function createAwesome() {
  const features = [
    'Real-time recording',
    'Cursor position tracking', 
    'Text selection replay',
    'Smooth playback'
  ];
  
  return features.map(f => `✨ ${f}`);
}

createAwesome();"
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
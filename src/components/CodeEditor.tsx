import React from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';

interface CodeEditorProps {
  language?: string;
  theme?: string;
  showImportExport?: boolean;
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
 */

const CodeEditor: React.FC<CodeEditorProps> = ({
  theme = 'vs-dark',
  showImportExport = true
}) => {
  const selectedLanguage = 'html';
  // Use the useScrimba context instead of Redux and custom hooks
  const {
    handleEditorChange, 
    editorRef,
    currentRecording,
    exportAsFile,
    importFromFile,
    loadRecording
  } = useScrimbaContext();


  const handleExport = async () => {
    if (currentRecording) {
      await exportAsFile(currentRecording);
    }
  };

  const handleImport = async () => {
    try {
      const importedRecordings = await importFromFile();
      console.log('Successfully imported recordings:', importedRecordings);
      
      // Load the first imported recording for playback
      if (importedRecordings.length > 0) {
        loadRecording(importedRecordings[0]);
        console.log(`Imported ${importedRecordings.length} recording(s) and loaded the first one for playback`);
      }
    } catch (error) {
      console.error('Import failed:', error);
      alert('Failed to import recording. Please check the file format.');
    }
  };

  const defaultContent = `<html>
    <h1>Hello world</h1>
</html>`;

  /**
   * Handle Monaco Editor mount event
   * Sets up the editor reference for use in recording and replay
   */
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };
  
  return (
    <div className="h-screen flex flex-col">
      {/* Title Bar with Import/Export buttons */}
      <div className="bg-gray-700 px-4 py-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-300">use-scrimba</span>
        {showImportExport && (
          <div className="flex items-center space-x-2">
            {/* Import/Export buttons */}
            <button
              onClick={handleImport}
              className="px-3 py-1 text-xs text-gray-300 hover:text-white bg-gray-600 hover:bg-gray-500 rounded transition-colors"
            >
              Import
            </button>
            <button
              onClick={handleExport}
              disabled={!currentRecording}
              className="px-3 py-1 text-xs text-gray-300 hover:text-white bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
            >
              Export
            </button>
          </div>
        )}
      </div>

      {/* Monaco Editor */}
      <div className="flex-1">
        <Editor
          height="100%"
          language={selectedLanguage}
          theme={theme}
          defaultValue={defaultContent}
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
      </div>

    </div>
  );
};

export default CodeEditor;
import React from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';
import SlidesButton from './SlidesButton';

interface CodeEditorProps {
  language?: string;
  theme?: string;
  showImportExport?: boolean;
  defaultContent?: string;
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
  theme = 'scrimba-dark',
  showImportExport = true,
  defaultContent = `<html>
    <h1>Hello world</h1>
</html>`
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

      // Load the first imported recording for playback
      if (importedRecordings.length > 0) {
        loadRecording(importedRecordings[0]);
      }
    } catch (error) {
      console.error('Import failed:', error);
      alert('Failed to import recording. Please check the file format.');
    }
  };

  /**
   * Handle Monaco Editor mount event
   * Sets up the editor reference for use in recording and replay
   */
  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    
    // Define Scrimba dark theme
    monaco.editor.defineTheme('scrimba-dark', {
      base: 'vs-dark',
      inherit: false,
      rules: [
        { token: '', foreground: 'D4D4D4', background: '202732' },
        { token: 'invalid', foreground: 'D4D4D4' },
        { token: 'emphasis', fontStyle: 'italic' },
        { token: 'strong', fontStyle: 'bold' },
        { token: 'property', foreground: 'F7FAFC' },
        { token: 'variable', foreground: 'e8e6cb' },
        { token: 'variable.predefined', foreground: 'ff9696' },
        { token: 'variable.parameter', foreground: '9CDCFE' },
        { token: 'identifier', foreground: '9dcbeb' },
        { token: 'accessor', foreground: 'F3F3F3' },
        { token: 'identifier.const', foreground: 'c1a5d6' },
        { token: 'identifier.constant', foreground: 'c1a5d6' },
        { token: 'identifier.const.class', foreground: '75AAFF' },
        { token: 'identifier.class', foreground: '75AAFF' },
        { token: 'identifier.classname', foreground: '75AAFF' },
        { token: 'identifier.const.tag', foreground: '75AAFF' },
        { token: 'identifier.decl', foreground: '75AAFF' },
        { token: 'identifier.tag', foreground: '75AAFF' },
        { token: 'identifier.tagname', foreground: '75AAFF' },
        { token: 'identifier.def', foreground: '75AAFF' },
        { token: 'identifier.key', foreground: 'a7c9de' },
        { token: 'identifier.env', foreground: 'ff9696' },
        { token: 'identifier.special', foreground: 'ffdb59' },
        { token: 'identifier.import', foreground: '91b7ea' },
        { token: 'identifier.symbol', foreground: 'ff9696' },
        { token: 'decorator.name', foreground: '9dcbeb' },
        { token: 'decorator.modifier.name', foreground: 'F3F3F3' },
        { token: 'entity.name', foreground: '75AAFF' },
        { token: 'entity.name.type', foreground: '75AAFF' },
        { token: 'entity.name.function', foreground: '75AAFF' },
        { token: 'entity.name.tag', foreground: 'e9e19b' },
        { token: 'path', foreground: '7da4b7' },
        { token: 'self', foreground: '63b3ed' },
        { token: 'this', foreground: '63b3ed' },
        { token: 'storage.type.function', foreground: 'ff9696' },
        { token: 'storage.type.class', foreground: 'ff9696' },
        { token: 'comment', foreground: '5D6E7A', fontStyle: 'italic' },
        { token: 'operator', foreground: 'ff9696' },
        { token: 'number', foreground: '29a7e4' },
        { token: 'number.hex', foreground: '29a7e4' },
        { token: 'numeric.css', foreground: '29a7e4' },
        { token: 'regexp', foreground: 'FD9231' },
        { token: 'regexp.escape', foreground: 'FFB26D' },
        { token: 'annotation', foreground: 'cc6666' },
        { token: 'type', foreground: '3DC9B0' },
        { token: 'boolean', foreground: '29a7e4' },
        { token: 'unit', foreground: 'ff8c8c' },
        { token: 'constant.numeric', foreground: '29a7e4' },
        { token: 'constant.language.boolean', foreground: '29a7e4' },
        { token: 'delimiter', foreground: 'DCDCDC' },
        { token: 'delimiter.access.imba', foreground: 'DCDCDB' },
        { token: 'delimiter.html', foreground: '808080' },
        { token: 'delimiter.xml', foreground: '808080' },
        { token: 'delimiter.eq.tag', foreground: 'ea9b7c' },
        { token: 'tag', foreground: 'e9e19b' },
        { token: 'tag.name', foreground: 'e9e19b' },
        { token: 'tag.open', foreground: '9d9755' },
        { token: 'tag.close', foreground: '9d9755' },
        { token: 'tag.attribute', foreground: 'e9e19b' },
        { token: 'tag.mixin', foreground: 'ffc87c' },
        { token: 'tag.reference', foreground: 'ffae86' },
        { token: 'tag.attribute.listener', foreground: 'e9e19b' },
        { token: 'tag.attribute.modifier', foreground: 'e9e19b' },
        { token: 'tag.operator', foreground: 'ff9696' },
        { token: 'tag.event', foreground: 'f3d8b5' },
        { token: 'paren.open.tag', foreground: 'e9e19b' },
        { token: 'paren.close.tag', foreground: 'e9e19b' },
        { token: 'meta.scss', foreground: 'A79873' },
        { token: 'meta.tag', foreground: 'e9e19b' },
        { token: 'metatag', foreground: 'DD6A6F' },
        { token: 'metatag.content.html', foreground: '9CDCFE' },
        { token: 'metatag.html', foreground: '569CD6' },
        { token: 'metatag.xml', foreground: '569CD6' },
        { token: 'metatag.php', fontStyle: 'bold' },
        { token: 'key', foreground: 'a7c9de' },
        { token: 'operator.assign.key', foreground: 'a7c9de' },
        { token: 'string.key.json', foreground: '9CDCFE' },
        { token: 'string.value.json', foreground: 'CE9178' },
        { token: 'attribute.name', foreground: 'a7c9de' },
        { token: 'attribute.value', foreground: '29a7e4' },
        { token: 'attribute.value.number.css', foreground: '29a7e4' },
        { token: 'attribute.value.unit.css', foreground: '29a7e4' },
        { token: 'attribute.value.hex.css', foreground: '29a7e4' },
        { token: 'string', foreground: '7da4b7' },
        { token: 'string.sql', foreground: '7da4b7' },
        { token: 'keyword', foreground: 'ff9696' },
        { token: 'keyword.flow', foreground: 'ff9696' },
        { token: 'keyword.json', foreground: 'ff9696' },
        { token: 'keyword.flow.scss', foreground: 'ff9696' },
        { token: 'operator.scss', foreground: '909090' },
        { token: 'operator.sql', foreground: '778899' },
        { token: 'predefined.sql', foreground: 'FF00FF' },
        { token: 'entity.name.selector.css', foreground: 'e9e19b' },
        { token: 'support.type.property-name.css', foreground: '75AAFF' },
        { token: 'meta.object-literal.key', foreground: 'a7c9de' },
        { token: 'style.selector', foreground: 'e9e19b' },
        { token: 'style.property', foreground: 'e0ade3' },
        { token: 'style.property.modifier', foreground: 'df8de4' },
        { token: 'style.mixin', foreground: 'ffc87c' },
        { token: 'style.value', foreground: 'a49feb' },
        { token: 'style.value.size', foreground: 'ff8c8c' },
        { token: 'style.start-operator', foreground: '6d829b' },
        { token: 'style.open', foreground: 'e9e19b' },
        { token: 'style.close', foreground: 'e9e19b' }
      ],
      colors: {
        'foreground': '#D4D4D4',
        'editor.background': '#202732',
        'editorGutter.background': '#202732',
        'editor.selectionBackground': '#30455f',
        'editorLineNumber.foreground': '#3c4e5d',
        'editorWidget.background': '#2d3748',
        'editorWidget.border': '#222a38',
        'list.focusBackground': '#33393f',
        'list.hoverBackground': '#202732',
        'list.highlightForeground': '#ffffff',
        'input.foreground': '#ffffff',
        'editorSuggestWidget.foreground': '#D4D4D4',
        'editorHoverWidget.background': '#2d3748',
        'editorHoverWidget.border': '#222a38',
        'editorError.foreground': '#f56565',
        'editorCursor.foreground': '#ffed4f',
        'widget.shadow': '#252d37',
        'input.background': '#252c37',
        'input.border': '#2a323f'
      }
    });

    // Apply the theme
    monaco.editor.setTheme('scrimba-dark');
  };

  return (
    <div className="h-screen flex flex-col">
      {/* Title Bar with Import/Export buttons */}
      <div className="bg-gray-700 px-4 py-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-300">use-scrimba</span>
        {showImportExport && (
          <div className="flex items-center space-x-2 relative">
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
            {/* Slides Button */}
            <SlidesButton />
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
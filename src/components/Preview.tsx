/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useRef, useEffect } from 'react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';

export default function Preview() {
  const [isMinimized, setIsMinimized] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastContentRef = useRef<string>('');
  const { editorRef } = useScrimbaContext();

  const updateIframeContent = (content: string) => {
    if (!iframeRef.current) return;

    // Skip update if content hasn't changed
    if (lastContentRef.current === content) return;
    lastContentRef.current = content;

    const iframe = iframeRef.current;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    // Detect content type
    const isHtml = content.trim().startsWith('<!DOCTYPE') ||
      content.trim().startsWith('<html') ||
      (content.includes('<body>') || content.includes('<head>'));
    const isCSS = content.includes('{') && content.includes('}') &&
      (content.includes(':') || content.includes('/*'));
    const isJS = !isHtml && !isCSS &&
      (content.includes('function') || content.includes('const') ||
        content.includes('let') || content.includes('var') ||
        content.includes('console.log') || content.includes('=>'));

    let htmlContent;

    if (isHtml) {
      // If it's HTML, inject it directly
      htmlContent = content;
    } else if (isCSS) {
      // If it's CSS, create a preview with sample HTML
      htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              ${content}
            </style>
          </head>
          <body>
            <h1>CSS Preview</h1>
            <p>This is a paragraph to show your CSS styles.</p>
            <div class="container">
              <h2>Sample Content</h2>
              <p>Your CSS styles are applied to this preview.</p>
              <button>Sample Button</button>
            </div>
          </body>
        </html>
      `;
    } else if (isJS) {
      // If it's JavaScript, create a simple execution environment
      htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body {
                font-family: Arial, sans-serif;
                padding: 20px;
                background: #f9f9f9;
              }
              .console {
                background: #1e1e1e;
                color: #00ff00;
                padding: 10px;
                border-radius: 4px;
                font-family: monospace;
                margin-top: 20px;
                white-space: pre-wrap;
              }
            </style>
          </head>
          <body>
            <h1>JavaScript Preview</h1>
            <p>Your JavaScript code is running. Check the console output below:</p>
            <div id="console" class="console">Console output will appear here...</div>
            
            <script>
              // Override console.log to display in the page
              const consoleDiv = document.getElementById('console');
              const originalConsoleLog = console.log;
              console.log = function(...args) {
                const message = args.map(arg => 
                  typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
                ).join(' ');
                consoleDiv.textContent += message + '\\n';
                originalConsoleLog.apply(console, args);
              };
              
              // Clear console first
              consoleDiv.textContent = '';
              
              try {
                ${content}
              } catch (error) {
                console.log('Error: ' + error.message);
              }
            </script>
          </body>
        </html>
      `;
    } else {
      // If it's not recognized, display as code
      htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body {
                font-family: 'Monaco', 'Menlo', monospace;
                font-size: 14px;
                line-height: 1.5;
                margin: 16px;
                background: #1e1e1e;
                color: #d4d4d4;
              }
              pre {
                white-space: pre-wrap;
                word-wrap: break-word;
                margin: 0;
              }
            </style>
          </head>
          <body>
            <pre>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
          </body>
        </html>
      `;
    }

    try {
      doc.open();
      doc.write(htmlContent);
      doc.close();
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    const checkForEditor = () => {
      const editor = editorRef.current;
      if (!editor) {
        setTimeout(checkForEditor, 100);
        return;
      }

      const updateContent = () => {
        const content = editor.getValue();
        updateIframeContent(content);
      };

      // Initial update
      updateContent();

      // Listen for changes
      const disposable = editor.onDidChangeModelContent(updateContent);

      // Cleanup function won't work here since we're in a timeout
      // Store the disposable in a way we can clean it up later
      (window as any).__iframeDisposable = disposable;
    };

    checkForEditor();

    // Cleanup
    return () => {
      const disposable = (window as any).__iframeDisposable;
      if (disposable) {
        disposable.dispose();
        delete (window as any).__iframeDisposable;
      }
    };
  }, []);

  // Update content when iframe becomes visible or size changes
  useEffect(() => {
    if (isMinimized) return;

    const editor = editorRef.current;
    if (!editor) return;

    // Small delay to ensure iframe is fully rendered
    const timer = setTimeout(() => {
      const content = editor.getValue();
      updateIframeContent(content);
    }, 50);

    return () => clearTimeout(timer);
  }, [isMinimized]);

  // Also ensure iframe loads properly
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleIframeLoad = () => {
      const editor = editorRef.current;
      if (editor) {
        const content = editor.getValue();
        updateIframeContent(content);
      }
    };

    iframe.addEventListener('load', handleIframeLoad);

    return () => {
      iframe.removeEventListener('load', handleIframeLoad);
    };
  }, [editorRef.current]);

  return (
    <>
      {/* Overlay for click-outside-to-minimize */}
      {!isMinimized && (
        <div
          className="fixed inset-0 z-39"
          onClick={() => setIsMinimized(true)}
        />
      )}

      <div
        className={`fixed bg-white rounded shadow-lg z-40 transition-all duration-500 ease-in-out origin-top-right ${isMinimized
            ? 'top-16 right-4 w-48 h-32'
            : 'w-[800px] h-[600px]'
          }`}
        style={{
          border: '1px solid #ccc',
          ...(!isMinimized && {
            top: '50%',
            right: '50%',
            transform: 'translate(50%, -50%)'
          })
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (isMinimized) {
            setIsMinimized(false);
          }
        }}
      >
        {/* Browser-style header */}
        <div className="flex items-center bg-gray-100 px-3 py-2 rounded-t-lg border-b">
          {/* Window controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsMinimized(!isMinimized)}
              className="w-3 h-3 rounded-full bg-yellow-400 hover:bg-yellow-500"
              title={isMinimized ? 'Maximize' : 'Minimize'}
            />
            <button
              className="w-3 h-3 rounded-full bg-green-400 hover:bg-green-500"
              title="Maximize"
              onClick={() => setIsMinimized(false)}
            />
          </div>

          <span className="text-sm font-medium text-gray-700 ml-4">Preview</span>
        </div>

        <iframe
          ref={iframeRef}
          className={`w-full border-0 rounded-b-lg ${isMinimized ? 'h-40' : ''}`}
          style={{ height: isMinimized ? 'calc(100% - 40px)' : 'calc(100% - 48px)' }}
          title="Code Preview"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </>
  );
}
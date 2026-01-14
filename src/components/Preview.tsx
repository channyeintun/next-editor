/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import type { PreviewSize, PreviewState, PreviewEvent } from '../types/slides';

interface PreviewProps {
  positioning?: 'fixed' | 'relative' | 'absolute' | 'sticky';
}

export default function Preview({ positioning = 'fixed' }: PreviewProps) {
  const [size, setSize] = useState<PreviewSize>('small');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastContentRef = useRef<string>('');
  const scrollPositionRef = useRef<{ scrollTop: number; scrollLeft: number }>({ scrollTop: 0, scrollLeft: 0 });
  const nextEditorContext = useNextEditorContext();
  const { editorRef, handlePreviewEvent, isRecording } = nextEditorContext;
  
  // Get registration functions from context
  const registerPreviewStateGetter = 'registerPreviewStateGetter' in nextEditorContext ? nextEditorContext.registerPreviewStateGetter : undefined;
  const registerPreviewStateApplier = 'registerPreviewStateApplier' in nextEditorContext ? nextEditorContext.registerPreviewStateApplier : undefined;

  // Emit preview event when size changes
  const emitPreviewEvent = useCallback((newSize: PreviewSize, eventType: PreviewEvent['type'], scrollTop?: number, scrollLeft?: number) => {
    if (isRecording && handlePreviewEvent) {
      const event: PreviewEvent = {
        type: eventType,
        timestamp: performance.now(),
        size: newSize,
        scrollTop,
        scrollLeft,
      };
      handlePreviewEvent(event);
    }
  }, [isRecording, handlePreviewEvent]);

  // Register preview state getter
  useEffect(() => {
    if (registerPreviewStateGetter && typeof registerPreviewStateGetter === 'function') {
      registerPreviewStateGetter((): PreviewState => ({
        size,
        scrollTop: scrollPositionRef.current.scrollTop,
        scrollLeft: scrollPositionRef.current.scrollLeft,
      }));
    }
  }, [registerPreviewStateGetter, size]);

  // Register preview state applier
  useEffect(() => {
    if (registerPreviewStateApplier && typeof registerPreviewStateApplier === 'function') {
      registerPreviewStateApplier((previewState: PreviewState) => {
        if (previewState.size !== size) {
          setSize(previewState.size);
        }
        // Apply scroll position during playback with smooth scrolling
        if (previewState.scrollTop !== undefined || previewState.scrollLeft !== undefined) {
          const iframe = iframeRef.current;
          if (iframe) {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            const iframeWindow = iframe.contentWindow;
            if (iframeDoc && iframeWindow) {
              const scrollTop = previewState.scrollTop ?? 0;
              const scrollLeft = previewState.scrollLeft ?? 0;
              
              // Use scrollTo with smooth behavior for natural scrolling
              try {
                iframeWindow.scrollTo({
                  top: scrollTop,
                  left: scrollLeft,
                  behavior: 'smooth'
                });
              } catch {
                // Fallback for older browsers or if smooth scroll fails
                if (iframeDoc.documentElement) {
                  iframeDoc.documentElement.scrollTop = scrollTop;
                  iframeDoc.documentElement.scrollLeft = scrollLeft;
                }
                if (iframeDoc.body) {
                  iframeDoc.body.scrollTop = scrollTop;
                  iframeDoc.body.scrollLeft = scrollLeft;
                }
              }
            }
          }
        }
      });
    }
  }, [registerPreviewStateApplier, size]);

  // Track scroll events in iframe during recording
  useEffect(() => {
    if (!isRecording) return;
    
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleScroll = () => {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) return;
      
      const scrollTop = iframeDoc.documentElement?.scrollTop || iframeDoc.body?.scrollTop || 0;
      const scrollLeft = iframeDoc.documentElement?.scrollLeft || iframeDoc.body?.scrollLeft || 0;
      
      scrollPositionRef.current = { scrollTop, scrollLeft };
      emitPreviewEvent(size, 'preview_scroll', scrollTop, scrollLeft);
    };

    const setupScrollListener = () => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          iframeDoc.addEventListener('scroll', handleScroll, true);
          // Also listen on the body and documentElement for better coverage
          if (iframeDoc.body) {
            iframeDoc.body.addEventListener('scroll', handleScroll, true);
          }
          iframeDoc.documentElement?.addEventListener('scroll', handleScroll, true);
        }
      } catch (error) {
        console.warn('Cannot track scroll in iframe:', error);
      }
    };

    // Setup listener when iframe loads
    const handleIframeLoad = () => {
      setupScrollListener();
    };

    iframe.addEventListener('load', handleIframeLoad);
    // Also try to setup immediately in case iframe is already loaded
    setupScrollListener();

    return () => {
      iframe.removeEventListener('load', handleIframeLoad);
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          iframeDoc.removeEventListener('scroll', handleScroll, true);
          if (iframeDoc.body) {
            iframeDoc.body.removeEventListener('scroll', handleScroll, true);
          }
          iframeDoc.documentElement?.removeEventListener('scroll', handleScroll, true);
        }
      } catch (error) {
        console.error('Error cleaning up scroll listener in iframe:', error);
      }
    };
  }, [isRecording, size, emitPreviewEvent]);

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
      // Use modern DOM manipulation instead of deprecated document.write
      doc.documentElement.innerHTML = htmlContent.replace(/^<!DOCTYPE html>\s*<html[^>]*>|<\/html>\s*$/gi, '');
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
    if (size === 'small') return;

    const editor = editorRef.current;
    if (!editor) return;

    // Small delay to ensure iframe is fully rendered
    const timer = setTimeout(() => {
      const content = editor.getValue();
      updateIframeContent(content);
    }, 50);

    return () => clearTimeout(timer);
  }, [size]);

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

  const getSizeClasses = () => {
    switch (size) {
      case 'small':
        return 'top-16 right-4 w-48 h-32 origin-top-right';
      case 'medium':
        return 'top-20 right-4 w-80 h-96 origin-top-right';
      case 'large':
        return 'w-[800px] max-w-[90vw] h-[600px] max-h-[90vh] origin-center';
    }
  };

  const getSizeStyles = () => {
    if (size === 'large') {
      return {
        top: '50%',
        right: '50%',
        transform: 'translate(50%, -50%)'
      };
    }
    return {};
  };

  const handleClick = () => {
    if (size === 'small') {
      setSize('medium');
      emitPreviewEvent('medium', 'preview_open');
    }
  };

  const handleMinimize = () => {
    setSize('small');
    emitPreviewEvent('small', 'preview_minimize');
  };

  const handleMaximize = () => {
    const newSize = size === 'large' ? 'medium' : 'large';
    setSize(newSize);
    emitPreviewEvent(newSize, 'preview_maximize');
  };

  return (
    <>
      {/* Overlay for click-outside-to-minimize - only for large size */}
      {size === 'large' && (
        <div
          className="fixed inset-0 z-39"
          onClick={handleMinimize}
        />
      )}

      <div
        className={`${positioning} bg-white rounded shadow-lg z-40 transition-all duration-500 ease-in-out ${getSizeClasses()}`}
        style={{
          border: '1px solid #ccc',
          ...getSizeStyles()
        }}
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
      >
        {/* Browser-style header */}
        <div className="flex items-center bg-gray-100 px-3 py-2 rounded-t-lg border-b">
          {/* Window controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMinimize();
              }}
              className="w-3 h-3 rounded-full bg-yellow-400 hover:bg-yellow-500"
              title="Minimize"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMaximize();
              }}
              className="w-3 h-3 rounded-full bg-green-400 hover:bg-green-500"
              title={size === 'large' ? 'Medium Size' : 'Maximize'}
            />
          </div>

          <span className="text-sm font-medium text-gray-700 ml-4">Preview</span>
        </div>

        <iframe
          ref={iframeRef}
          className="w-full border-0 rounded-b-lg"
          style={{ height: 'calc(100% - 48px)' }}
          title="Code Preview"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </>
  );
}
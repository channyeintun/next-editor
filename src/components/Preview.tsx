import { useState, useRef, useEffect, useCallback } from 'react';
import type * as monaco from 'monaco-editor';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import type { PreviewSize, PreviewState, PreviewEvent, IframeInteractionEvent } from '../types/slides';

interface PreviewProps {
  positioning?: 'fixed' | 'relative' | 'absolute' | 'sticky';
}

// ============================================================================
// XPath Utility
// ============================================================================

/**
 * Find element by XPath
 */
function getElementByXPath(doc: Document, xpath: string): Element | null {
  try {
    const result = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue as Element | null;
  } catch {
    return null;
  }
}

export default function Preview({ positioning = 'fixed' }: PreviewProps) {
  const [size, setSize] = useState<PreviewSize>('small');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastContentRef = useRef<string>('');
  const scrollPositionRef = useRef<{ scrollTop: number; scrollLeft: number }>({ scrollTop: 0, scrollLeft: 0 });
  const disposableRef = useRef<monaco.IDisposable | null>(null);
  const pendingInteractionRef = useRef<IframeInteractionEvent | null>(null);
  const setupInteractionListenersRef = useRef<(() => (() => void) | undefined) | null>(null);
  const cleanupListenersRef = useRef<(() => void) | undefined>(undefined);
  // Refs to store latest recording state and handler (to bypass closure issues)
  const isRecordingRef = useRef<boolean>(false);
  const handlePreviewEventRef = useRef<typeof handlePreviewEvent | null>(null);
  const nextEditorContext = useNextEditorContext();
  const { editorRef, handlePreviewEvent, isRecording, files, activeFile } = nextEditorContext;

  const fileUrlsRef = useRef<Record<string, string>>({});
  const fileContentsRef = useRef<Record<string, string>>({});

  // Cleanup Blob URLs on unmount
  useEffect(() => {
    const currentFileUrls = fileUrlsRef.current;
    return () => {
      Object.values(currentFileUrls).forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  const getFileUrl = useCallback((path: string, content: string) => {
    if (fileContentsRef.current[path] === content && fileUrlsRef.current[path]) {
      return fileUrlsRef.current[path];
    }

    if (fileUrlsRef.current[path]) {
      URL.revokeObjectURL(fileUrlsRef.current[path]);
    }

    let type = 'text/plain';
    if (path.endsWith('.css')) type = 'text/css';
    else if (path.endsWith('.js')) type = 'application/javascript';
    else if (path.endsWith('.html')) type = 'text/html';

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);

    fileContentsRef.current[path] = content;
    fileUrlsRef.current[path] = url;
    return url;
  }, []);

  const resolveReferences = useCallback((html: string, consolidatedFiles: Record<string, string>) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Handle relative references
    doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      const href = link.getAttribute('href');
      if (href && consolidatedFiles[href]) {
        link.setAttribute('href', getFileUrl(href, consolidatedFiles[href]));
      }
    });

    doc.querySelectorAll('script[src]').forEach(script => {
      const src = script.getAttribute('src');
      if (src && consolidatedFiles[src]) {
        script.setAttribute('src', getFileUrl(src, consolidatedFiles[src]));
      }
    });

    // Handle images if they are in base64/data URLs in our files record
    doc.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (src && consolidatedFiles[src]) {
        img.setAttribute('src', getFileUrl(src, consolidatedFiles[src]));
      }
    });

    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }, [getFileUrl]);

  // Keep refs updated synchronously
  isRecordingRef.current = isRecording;
  handlePreviewEventRef.current = handlePreviewEvent;

  // Get registration functions from context
  const registerPreviewStateGetter = 'registerPreviewStateGetter' in nextEditorContext ? nextEditorContext.registerPreviewStateGetter : undefined;
  const registerPreviewStateApplier = 'registerPreviewStateApplier' in nextEditorContext ? nextEditorContext.registerPreviewStateApplier : undefined;

  // Emit preview event
  const emitPreviewEvent = useCallback((
    eventType: PreviewEvent['type'],
    options?: {
      newSize?: PreviewSize;
      scrollTop?: number;
      scrollLeft?: number;
      interaction?: IframeInteractionEvent;
    }
  ) => {
    if (isRecording && handlePreviewEvent) {
      const event: PreviewEvent = {
        type: eventType,
        timestamp: performance.now(),
        size: options?.newSize ?? size,
        scrollTop: options?.scrollTop,
        scrollLeft: options?.scrollLeft,
        interaction: options?.interaction,
      };
      handlePreviewEvent(event);
    }
  }, [isRecording, handlePreviewEvent, size]);

  // Emit interaction event


  // Handle messages from the iframe (postMessage approach)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Ensure the message is from our iframe
      if (event.source !== iframeRef.current?.contentWindow) return;

      const { type, payload } = event.data || {};
      if (type === 'IFRAME_INTERACTION') {
        // Update scroll position if it's a scroll event on the main document
        const isMainDocumentScroll = payload.type === 'scroll' && payload.data && (payload.data.isDocument || payload.targetTag === 'BODY' || payload.targetTag === 'HTML');

        if (isMainDocumentScroll) {
          scrollPositionRef.current = {
            scrollTop: payload.data.scrollTop,
            scrollLeft: payload.data.scrollLeft
          };

          if (isRecordingRef.current && handlePreviewEventRef.current) {
            handlePreviewEventRef.current({
              type: 'preview_scroll',
              timestamp: Date.now(),
              size: size,
              scrollTop: payload.data.scrollTop,
              scrollLeft: payload.data.scrollLeft,
            });
          }
        } else if (isRecordingRef.current && handlePreviewEventRef.current) {
          const interaction: IframeInteractionEvent = {
            type: payload.type,
            timestamp: performance.now(),
            target: payload.target,
            data: payload.data,
          };

          pendingInteractionRef.current = interaction;
          handlePreviewEventRef.current({
            type: 'preview_interaction',
            timestamp: Date.now(),
            size: size,
            scrollTop: scrollPositionRef.current.scrollTop,
            scrollLeft: scrollPositionRef.current.scrollLeft,
            interaction,
          });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [size]); // size is used in the event object

  // Register preview state getter
  useEffect(() => {
    if (registerPreviewStateGetter && typeof registerPreviewStateGetter === 'function') {
      registerPreviewStateGetter((): PreviewState => {
        const interaction = pendingInteractionRef.current;
        pendingInteractionRef.current = null; // Consume the interaction

        return {
          size,
          scrollTop: scrollPositionRef.current.scrollTop,
          scrollLeft: scrollPositionRef.current.scrollLeft,
          currentInteraction: interaction || undefined,
        };
      });
    }
  }, [registerPreviewStateGetter, size]);

  // Register preview state applier (handles playback)
  useEffect(() => {
    if (registerPreviewStateApplier && typeof registerPreviewStateApplier === 'function') {
      registerPreviewStateApplier((previewState: PreviewState) => {
        if (previewState.size !== size) {
          setSize(previewState.size);
        }

        const iframe = iframeRef.current;
        if (!iframe) return;

        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        const iframeWindow = iframe.contentWindow;
        if (!iframeDoc || !iframeWindow) return;

        // Apply scroll position (idempotent and non-smooth to stay in sync with ticks)
        if (previewState.scrollTop !== undefined || previewState.scrollLeft !== undefined) {
          const targetTop = previewState.scrollTop ?? 0;
          const targetLeft = previewState.scrollLeft ?? 0;

          let currentTop: number = 0;
          let currentLeft: number = 0;
          let scrollTarget: Element | Window | null = null;

          if (previewState.currentInteraction?.type === 'scroll' && previewState.currentInteraction.data && !previewState.currentInteraction.data.isDocument) {
            // Sub-element scroll
            const targetElement = getElementByXPath(iframeDoc, previewState.currentInteraction.target.xpath);
            if (targetElement instanceof Element) {
              scrollTarget = targetElement;
              currentTop = targetElement.scrollTop;
              currentLeft = targetElement.scrollLeft;
            }
          }

          if (!scrollTarget) {
            // Default to window/document scroll
            currentTop = iframeWindow.scrollY || iframeDoc.documentElement.scrollTop;
            currentLeft = iframeWindow.scrollX || iframeDoc.documentElement.scrollLeft;
            scrollTarget = iframeWindow;
          }

          // Relaxed threshold to 1px for smoother low-speed scroll replay
          if (Math.abs(currentTop - targetTop) > 1 || Math.abs(currentLeft - targetLeft) > 1) {
            try {
              if (scrollTarget === iframeWindow) {
                iframeWindow.scrollTo({ top: targetTop, left: targetLeft, behavior: 'auto' });
              } else if (scrollTarget instanceof Element) {
                scrollTarget.scrollTop = targetTop;
                scrollTarget.scrollLeft = targetLeft;
              }
            } catch {
              if (iframeDoc.documentElement && scrollTarget === iframeWindow) {
                iframeDoc.documentElement.scrollTop = targetTop;
                iframeDoc.documentElement.scrollLeft = targetLeft;
              }
            }
          }
        }

        // Apply interaction replay
        if (previewState.currentInteraction) {
          const interaction = previewState.currentInteraction;

          const element = getElementByXPath(iframeDoc, interaction.target.xpath) as HTMLElement | null;

          if (!element) return;

          // In an iframe, standard instanceof checks can fail because constructors belong to the iframe's window.
          // Since we've cast to HTMLElement, we can check for style presence.
          const elementWithStyle = element as (HTMLElement & { value?: string });
          const isElementWithStyle = !!elementWithStyle.style;
          const tagName = element.tagName.toLowerCase();

          if (isElementWithStyle) {
            // Apply visual feedback based on interaction type
            switch (interaction.type) {
              case 'click':
                elementWithStyle.style.setProperty('--ring-color', 'rgba(59, 130, 246, 0.5)');
                elementWithStyle.style.boxShadow = '0 0 0 4px rgba(59, 130, 246, 0.5)';
                setTimeout(() => {
                  elementWithStyle.style.removeProperty('--ring-color');
                  elementWithStyle.style.boxShadow = '';
                }, 300);
                break;
              case 'hover_start':
                elementWithStyle.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
                break;
              case 'hover_end':
                elementWithStyle.style.backgroundColor = '';
                break;
              case 'focus':
                elementWithStyle.focus();
                break;
              case 'scroll':
                if (interaction.data?.scrollTop !== undefined) {
                  elementWithStyle.scrollTop = interaction.data.scrollTop;
                }
                if (interaction.data?.scrollLeft !== undefined) {
                  elementWithStyle.scrollLeft = interaction.data.scrollLeft;
                }
                break;
              case 'input': {
                const isInput = tagName === 'input' || tagName === 'textarea' || elementWithStyle.isContentEditable;
                if (isInput && interaction.data?.value !== undefined) {
                  elementWithStyle.value = interaction.data.value;
                }
                break;
              }
            }
          }
        }
      });
    }
  }, [registerPreviewStateApplier, size]);

  // Track all interaction events in iframe during recording
  useEffect(() => {
    if (!isRecording) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const setupInteractionListeners = () => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) return;

        // Self-contained capture script to be injected into the iframe
        const captureScript = `
          (function() {
            if (window.__INTERACTION_CAPTURE_SETUP__) return;
            window.__INTERACTION_CAPTURE_SETUP__ = true;
            
            
            function getXPath(element) {
              if (element.id) return '//*[@id="' + element.id + '"]';
              if (element === document.body) return '/html/body';
              const parent = element.parentElement;
              if (!parent) return '/' + element.tagName.toLowerCase();
              const siblings = Array.from(parent.children).filter(s => s.tagName === element.tagName);
              const index = siblings.indexOf(element) + 1;
              return getXPath(parent) + '/' + element.tagName.toLowerCase() + (siblings.length > 1 ? '[' + index + ']' : '');
            }

            function getTargetInfo(element) {
              return {
                tagName: element.tagName.toLowerCase(),
                id: element.id || undefined,
                className: element.className || undefined,
                xpath: getXPath(element)
              };
            }

            function emit(type, target, data) {
              window.parent.postMessage({
                type: 'IFRAME_INTERACTION',
                payload: {
                  type: type,
                  target: getTargetInfo(target),
                  targetTag: target.tagName,
                  data: data
                }
              }, '*');
            }

            document.addEventListener('click', (e) => {
              emit('click', e.target, { clientX: e.clientX, clientY: e.clientY, button: e.button });
            }, true);

            document.addEventListener('mouseenter', (e) => {
              if (e.target !== document.body && e.target instanceof Element) {
                emit('hover_start', e.target, { clientX: e.clientX, clientY: e.clientY });
              }
            }, true);

            document.addEventListener('mouseleave', (e) => {
              if (e.target !== document.body && e.target instanceof Element) {
                emit('hover_end', e.target);
              }
            }, true);

            document.addEventListener('focus', (e) => {
              if (e.target instanceof Element) emit('focus', e.target);
            }, true);

            document.addEventListener('blur', (e) => {
              if (e.target instanceof Element) emit('blur', e.target);
            }, true);

            document.addEventListener('keydown', (e) => {
              if (e.target instanceof Element) emit('keydown', e.target, { key: e.key, code: e.code });
            }, true);

            document.addEventListener('keyup', (e) => {
              if (e.target instanceof Element) emit('keyup', e.target, { key: e.key, code: e.code });
            }, true);

            document.addEventListener('input', (e) => {
              const tag = e.target.tagName.toLowerCase();
              if (tag === 'input' || tag === 'textarea') {
                emit('input', e.target, { value: e.target.value });
              }
            }, true);

            document.addEventListener('scroll', (e) => {
              const target = e.target;
              if (target === document || target === window || target === document.body || target === document.documentElement) {
                const doc = document.scrollingElement || document.documentElement;
                emit('scroll', document.body, { 
                  scrollTop: doc.scrollTop, 
                  scrollLeft: doc.scrollLeft,
                  isDocument: true
                });
              } else if (target instanceof Element) {
                emit('scroll', target, { 
                  scrollTop: target.scrollTop, 
                  scrollLeft: target.scrollLeft,
                  isDocument: false
                });
              }
            }, true);
          })();
        `;

        const scriptEl = iframeDoc.createElement('script');
        scriptEl.textContent = captureScript;
        if (iframeDoc.head) {
          iframeDoc.head.appendChild(scriptEl);
        } else {
          iframeDoc.documentElement.appendChild(scriptEl);
        }

        return () => {
          // No clean cleanup needed as the script lives in the iframe document which gets destroyed
        };
      } catch (error) {
        console.warn('Cannot track interactions in iframe (likely cross-origin):', error);
        return undefined;
      }
    };

    // Store the setup function in ref so updateIframeContent can call it
    setupInteractionListenersRef.current = setupInteractionListeners;

    let cleanup: (() => void) | undefined;

    const handleIframeLoad = () => {
      cleanup?.();
      cleanup = setupInteractionListeners();
      cleanupListenersRef.current = cleanup;
    };

    iframe.addEventListener('load', handleIframeLoad);
    cleanup = setupInteractionListeners();
    cleanupListenersRef.current = cleanup;

    return () => {
      iframe.removeEventListener('load', handleIframeLoad);
      cleanup?.();
      setupInteractionListenersRef.current = null;
      cleanupListenersRef.current = undefined;
    };
  }, [isRecording, emitPreviewEvent, size]);

  const updateIframeContent = useCallback((contentOverride?: string) => {
    if (!iframeRef.current) return;

    const consolidatedFiles = { ...files };
    if (editorRef.current && activeFile) {
      consolidatedFiles[activeFile] = contentOverride !== undefined ? contentOverride : editorRef.current.getValue();
    }

    // Skip update if nothing changed
    const currentActiveContent = consolidatedFiles[activeFile] || '';
    if (lastContentRef.current === currentActiveContent && !contentOverride) {
      // Potentially other files changed, but we only re-render if the Entry File or Active File content changed
      // For now, let's keep it simple and check if any file changed
    }
    lastContentRef.current = currentActiveContent;

    const iframe = iframeRef.current;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    // Determine the entry point: prefer index.html if it exists, otherwise use activeFile
    let entryFile = activeFile;
    if (consolidatedFiles['index.html']) {
      entryFile = 'index.html';
    }

    const content = consolidatedFiles[entryFile] || '';
    const extension = entryFile.split('.').pop()?.toLowerCase();

    // Detect content type
    const isHtml = extension === 'html' || content.trim().startsWith('<!DOCTYPE') ||
      content.trim().startsWith('<html') ||
      (content.includes('<body>') || content.includes('<head>'));
    const isCSS = !isHtml && (extension === 'css' || (content.includes('{') && content.includes('}') &&
      (content.includes(':') || content.includes('/*'))));
    const isJS = !isHtml && !isCSS && (extension === 'js' ||
      (content.includes('function') || content.includes('const') ||
        content.includes('let') || content.includes('var') ||
        content.includes('console.log') || content.includes('=>')));

    let htmlContent;

    if (isHtml) {
      // If it's HTML, resolve references and inject
      htmlContent = resolveReferences(content, consolidatedFiles);
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
            <h1>CSS Preview (${entryFile})</h1>
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
              body { font-family: sans-serif; padding: 20px; background: #f9f9f9; }
              .console { background: #1e1e1e; color: #00ff00; padding: 10px; border-radius: 4px; font-family: monospace; margin-top: 20px; white-space: pre-wrap; }
            </style>
          </head>
          <body>
            <h1>JavaScript Preview (${entryFile})</h1>
            <p>Your JavaScript code is running. Check the console output below:</p>
            <div id="console" class="console">Console output will appear here...</div>
            <script>
              const consoleDiv = document.getElementById('console');
              const originalConsoleLog = console.log;
              console.log = function(...args) {
                const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
                consoleDiv.textContent += message + '\\n';
                originalConsoleLog.apply(console, args);
              };
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
            <style>
              body { font-family: monospace; font-size: 14px; line-height: 1.5; margin: 16px; background: #1e1e1e; color: #d4d4d4; }
              pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; }
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

      // Re-attach interaction listeners after content update
      if (setupInteractionListenersRef.current) {
        cleanupListenersRef.current?.();
        cleanupListenersRef.current = setupInteractionListenersRef.current();
      }
    } catch (error) {
      console.error(error);
    }
  }, [files, activeFile, editorRef, resolveReferences]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const updateContent = () => {
      updateIframeContent();
    };

    // Initial update
    updateContent();

    // Listen for changes
    const disposable = editor.onDidChangeModelContent(updateContent);

    // Store the disposable in a ref so we can clean it up later
    disposableRef.current = disposable;

    // Cleanup
    return () => {
      if (disposableRef.current) {
        disposableRef.current.dispose();
        disposableRef.current = null;
      }
    };
  }, [editorRef, updateIframeContent, activeFile, files]);

  // Update content when iframe becomes visible or size changes
  useEffect(() => {
    if (size === 'small') return;

    const editor = editorRef.current;
    if (!editor) return;

    // Small delay to ensure iframe is fully rendered
    const timer = setTimeout(() => {
      updateIframeContent();
    }, 50);

    return () => clearTimeout(timer);
  }, [size, editorRef, updateIframeContent, activeFile, files]);

  // Also ensure iframe loads properly
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleIframeLoad = () => {
      updateIframeContent();
    };

    iframe.addEventListener('load', handleIframeLoad);

    return () => {
      iframe.removeEventListener('load', handleIframeLoad);
    };
  }, [editorRef, updateIframeContent, activeFile, files]);

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
      emitPreviewEvent('preview_open', { newSize: 'medium' });
    }
  };

  const handleMinimize = () => {
    setSize('small');
    emitPreviewEvent('preview_minimize', { newSize: 'small' });
  };

  const handleMaximize = () => {
    const newSize = size === 'large' ? 'medium' : 'large';
    setSize(newSize);
    emitPreviewEvent('preview_maximize', { newSize });
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
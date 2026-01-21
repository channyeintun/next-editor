import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, type Transition } from 'motion/react';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import type { PreviewSize, PreviewState, PreviewEvent, IframeInteractionEvent } from '../types/slides';



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

export default function Preview() {
  const [size, setSize] = useState<PreviewSize>('small');
  const [isTransitioning, setIsTransitioning] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const lastContentRef = useRef<string>('');
  const scrollPositionRef = useRef<{ scrollTop: number; scrollLeft: number }>({ scrollTop: 0, scrollLeft: 0 });
  const pendingInteractionRef = useRef<IframeInteractionEvent | null>(null);
  const setupInteractionListenersRef = useRef<(() => (() => void) | undefined) | null>(null);
  const cleanupListenersRef = useRef<(() => void) | undefined>(undefined);

  // Refs for scroll throttling
  const targetScrollRef = useRef<{ scrollTop: number; scrollLeft: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const isUserScrollingRef = useRef<boolean>(false);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Refs to store latest recording state and handler (to bypass closure issues)
  const isRecordingRef = useRef<boolean>(false);
  const handlePreviewEventRef = useRef<typeof handlePreviewEvent | null>(null);
  const nextEditorContext = useNextEditorContext();
  const { editorRef, handlePreviewEvent, isRecording } = nextEditorContext;

  // Keep refs updated synchronously
  isRecordingRef.current = isRecording;
  handlePreviewEventRef.current = handlePreviewEvent;

  const sizeRef = useRef<PreviewSize>(size);
  sizeRef.current = size;

  // Get registration functions from context
  const registerPreviewStateGetter = 'registerPreviewStateGetter' in nextEditorContext ? nextEditorContext.registerPreviewStateGetter : undefined;
  const registerPreviewStateApplier = 'registerPreviewStateApplier' in nextEditorContext ? nextEditorContext.registerPreviewStateApplier : undefined;

  // Emit preview event
  const emitPreviewEvent = useCallback((
    eventType: PreviewEvent['type'],
    options?: {
      newSize?: PreviewSize;
      content?: string;
      scrollTop?: number;
      scrollLeft?: number;
      interaction?: IframeInteractionEvent;
    }
  ) => {
    if (isRecordingRef.current && handlePreviewEventRef.current) {
      const event: PreviewEvent = {
        type: eventType,
        timestamp: performance.now(),
        size: options?.newSize ?? sizeRef.current,
        content: options?.content,
        scrollTop: options?.scrollTop,
        scrollLeft: options?.scrollLeft,
        interaction: options?.interaction,
      };
      handlePreviewEventRef.current(event);
    }
  }, []);

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
            // Mark as user scrolling to disable LERP temporarily (avoids fighting)
            isUserScrollingRef.current = true;
            if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current);
            userScrollTimeoutRef.current = setTimeout(() => {
              isUserScrollingRef.current = false;
            }, 100);

            // Sync target rewf
            targetScrollRef.current = {
              scrollTop: payload.data.scrollTop,
              scrollLeft: payload.data.scrollLeft
            };

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
          content: lastContentRef.current,
          scrollTop: scrollPositionRef.current.scrollTop,
          scrollLeft: scrollPositionRef.current.scrollLeft,
          currentInteraction: interaction || undefined,
        };
      });
    }
  }, [registerPreviewStateGetter, size]);

  const updateIframeContent = useCallback((content: string) => {
    if (!iframeRef.current) return;

    // Skip update if content hasn't changed
    if (lastContentRef.current === content) return;
    lastContentRef.current = content;

    const iframe = iframeRef.current;

    try {
      // Use srcdoc with the content directly (single HTML entry support)
      iframe.srcdoc = content;
    } catch (error) {
      console.error('Error updating iframe srcdoc:', error);
    }
  }, []);

  // Register preview state applier (handles playback)
  useEffect(() => {
    if (registerPreviewStateApplier && typeof registerPreviewStateApplier === 'function') {
      registerPreviewStateApplier((previewState: PreviewState) => {
        if (JSON.stringify(previewState.size) !== JSON.stringify(size)) {
          setSize(previewState.size);
        }

        if (previewState.content !== undefined && previewState.content !== lastContentRef.current) {
          updateIframeContent(previewState.content);
        }

        const iframe = iframeRef.current;
        if (!iframe) return;

        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        const iframeWindow = iframe.contentWindow;
        if (!iframeDoc || !iframeWindow) return;

        // Apply scroll position with LERP
        if (previewState.scrollTop !== undefined || previewState.scrollLeft !== undefined) {
          const targetTop = previewState.scrollTop ?? 0;
          const targetLeft = previewState.scrollLeft ?? 0;

          // If we are recording, don't fight the user's scroll
          if (isRecordingRef.current && isUserScrollingRef.current) {
            return;
          }

          // Update target
          targetScrollRef.current = { scrollTop: targetTop, scrollLeft: targetLeft };

          // Apply in RAF to allow coalescing of rapid updates and match display refresh rate
          if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null;

              const target = targetScrollRef.current;
              if (!target || !iframeRef.current) return;

              const iframe = iframeRef.current;
              const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
              const iframeWindow = iframe.contentWindow;

              if (!iframeDoc || !iframeWindow) return;

              // Determine scroll target (window vs element)
              let scrollTarget: Element | Window = iframeWindow;

              if (previewState.currentInteraction?.type === 'scroll' && previewState.currentInteraction.data && !previewState.currentInteraction.data.isDocument) {
                const el = getElementByXPath(iframeDoc, previewState.currentInteraction.target.xpath);
                if (el instanceof Element) scrollTarget = el;
              }

              // Get current scroll to check threshold
              let currentTop = 0;
              let currentLeft = 0;
              try {
                if (scrollTarget === iframeWindow) {
                  currentTop = iframeWindow.scrollY || iframeDoc.documentElement.scrollTop;
                  currentLeft = iframeWindow.scrollX || iframeDoc.documentElement.scrollLeft;
                } else if (scrollTarget instanceof Element) {
                  currentTop = scrollTarget.scrollTop;
                  currentLeft = scrollTarget.scrollLeft;
                }
              } catch (error: unknown) {
                console.warn('Failed to read scroll position:', error);
              }

              // Threshold check (0.1px) for efficiency
              if (Math.abs(currentTop - target.scrollTop) > 0.1 || Math.abs(currentLeft - target.scrollLeft) > 0.1) {
                try {
                  if (scrollTarget === iframeWindow) {
                    iframeWindow.scrollTo({ top: target.scrollTop, left: target.scrollLeft, behavior: 'instant' });
                  } else if (scrollTarget instanceof Element) {
                    scrollTarget.scrollTo({ top: target.scrollTop, left: target.scrollLeft, behavior: 'instant' });
                  }
                } catch (error: unknown) {
                  console.warn('Failed to update scroll position:', error);
                }
              }
            });
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
  }, [registerPreviewStateApplier, size, updateIframeContent]);

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

            let scrollTicking = false;
            document.addEventListener('scroll', (e) => {
              if (scrollTicking) return;
              
              const target = e.target;
              scrollTicking = true;
              
              requestAnimationFrame(() => {
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
                scrollTicking = false;
              });
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


  useEffect(() => {
    const checkForEditor = () => {
      const editor = editorRef.current;
      if (!editor) {
        setTimeout(checkForEditor, 100);
        return;
      }

      // Initial update if not already set
      if (!lastContentRef.current) {
        updateIframeContent(editor.getValue());
      }
    };

    checkForEditor();
  }, [editorRef, updateIframeContent]);


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
  }, [editorRef, updateIframeContent]);

  const isLarge = size === 'large';
  const isMedium = size === 'medium';
  const isSmall = size === 'small';

  const getSizeClasses = () => {
    if (isLarge) return 'shadow-2xl border border-black/10 transition-shadow z-[100]';
    if (isMedium) return 'shadow-lg border border-gray-300 transition-shadow z-32';
    return 'shadow-md border border-gray-300 cursor-pointer transition-shadow z-31';
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

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      setIsRefreshing(true);
      const content = editor.getValue();
      // Force refresh by clearing lastContentRef and manually calling update
      lastContentRef.current = '';
      updateIframeContent(content);
      emitPreviewEvent('preview_refresh', { content });

      // Stop spinning after a delay to show it happen
      setTimeout(() => setIsRefreshing(false), 600);
    }
  }, [editorRef, updateIframeContent, emitPreviewEvent]);

  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startX = e.clientX;
    const startY = e.clientY;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const rect = iframe.parentElement?.getBoundingClientRect();
    if (!rect) return;

    const startWidth = rect.width;
    const startHeight = rect.height;

    let resizeRaf: number | null = null;
    const onMouseMove = (moveEvent: MouseEvent) => {
      // Anchored at top-right, so dragging left increases width
      const deltaX = startX - moveEvent.clientX;
      const deltaY = moveEvent.clientY - startY;

      const maxWidth = window.innerWidth - 32; // 1rem padding right + 1rem padding left
      const maxHeight = window.innerHeight - 96; // 5rem top offset + small bottom padding

      const newWidth = Math.min(maxWidth, Math.max(160, startWidth + deltaX));
      const newHeight = Math.min(maxHeight, Math.max(120, startHeight + deltaY));

      const newSize = { width: newWidth, height: newHeight };
      setSize(newSize);

      // Record resizing event during the drag for granular replay
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        emitPreviewEvent('preview_resize', { newSize });
      });
    };

    const onMouseUp = () => {
      setIsResizing(false);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      // One final emit to ensure accuracy
      emitPreviewEvent('preview_resize');
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const springTransition: Transition = {
    type: 'spring',
    stiffness: 260,
    damping: 26,
    mass: 1,
  };

  const getPreviewVariants = () => {
    const base = {
      small: {
        top: "4rem",
        right: "1rem",
        width: "12rem",
        height: "8rem",
        left: "auto",
        bottom: "auto"
      },
      medium: {
        top: "5rem",
        right: "1rem",
        width: "20rem",
        height: "28rem",
        left: "auto",
        bottom: "auto"
      },
      large: {
        top: "10%",
        right: "10%",
        bottom: "10%",
        left: "10%",
        width: "80%",
        height: "80%"
      }
    };

    if (typeof size === 'object') {
      return {
        ...base,
        custom: {
          top: "5rem",
          right: "1rem",
          width: `${size.width}px`,
          height: `${size.height}px`,
          left: "auto",
          bottom: "auto"
        }
      };
    }
    return base;
  };

  const variants = getPreviewVariants();
  const animateState = typeof size === 'object' ? 'custom' : size;

  return (
    <>
      {/* Overlay for click-outside-to-minimize - only for large size */}
      <AnimatePresence>
        {isLarge && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/10"
            onClick={handleMinimize}
          />
        )}
      </AnimatePresence>

      <motion.div
        variants={variants}
        initial={false}
        animate={animateState}
        transition={springTransition}
        onAnimationStart={() => setIsTransitioning(true)}
        onAnimationComplete={() => setIsTransitioning(false)}
        className={`fixed bg-white rounded-xl overflow-hidden flex flex-col ${getSizeClasses()} ${isSmall ? 'hover:shadow-xl active:scale-95' : ''}`}
        onClick={(e) => {
          if (isSmall) {
            e.stopPropagation();
            handleClick();
          }
        }}
      >
        {/* Browser-style header */}
        <div className="flex items-center bg-gray-50/80 backdrop-blur-md px-3 py-2 border-b border-gray-200">
          {/* Window controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMinimize();
              }}
              className="w-3 h-3 rounded-full bg-rose-400 hover:bg-rose-500 transition-colors flex items-center justify-center group"
              title="Minimize"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-rose-900/20 opacity-0 group-hover:opacity-100" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMaximize();
              }}
              className="w-3 h-3 rounded-full bg-amber-400 hover:bg-amber-500 transition-colors flex items-center justify-center group"
              title={isLarge ? 'Medium Size' : 'Maximize'}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-amber-900/20 opacity-0 group-hover:opacity-100" />
            </button>
          </div>

          <div className="flex-1" />

          {/* Refresh button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRefresh();
            }}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all active:scale-95"
            title="Refresh Preview"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={isRefreshing ? 'animate-spin' : ''}
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
        </div>

        <div className="relative flex-1">
          <iframe
            ref={iframeRef}
            className={`absolute inset-0 w-full h-full block border-0 bg-transparent align-middle ${isTransitioning || isResizing ? 'pointer-events-none' : ''}`}
            title="Code Preview"
            sandbox="allow-scripts allow-same-origin"
          />

          {/* Resize handle */}
          <div
            onMouseDown={handleResizeStart}
            className="absolute bottom-0 left-0 w-8 h-8 cursor-sw-resize flex items-end justify-start z-50 group hover:bg-black/5 rounded-tr-3xl transition-colors"
            title="Drag to resize"
          >
            <div className="mb-1.5 ml-1.5 flex flex-col items-start gap-[2px]">
              <div className="w-4 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
              <div className="w-2.5 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
              <div className="w-1 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
            </div>

            {/* Visual background triangle */}
            <svg
              className="absolute bottom-0 left-0 w-8 h-8 text-gray-200/50 group-hover:text-blue-500/10 transition-colors -z-10"
              viewBox="0 0 32 32"
            >
              <path d="M0 32 L32 32 L0 0 Z" fill="currentColor" />
            </svg>
          </div>
        </div>
      </motion.div>
    </>
  );
}
import { useEffect, useRef, useCallback, useState, memo } from 'react';
import type { SlideContentType } from '../types/slides';

interface RevealSlideRendererProps {
  slides: Array<{
    id: string;
    content: string;
    contentType: SlideContentType;
  }>;
  currentSlideIndex: number;
  currentVerticalIndex: number;
  onSlideChange?: (indexh: number, indexv?: number) => void;
  isNavigationEnabled?: boolean;
  currentInteraction?: import('../types/slides').IframeInteractionEvent;
  registerSlideNavigator?: (navigator: (indexh: number, indexv: number) => void) => void;
}

// Generate the complete HTML for the reveal.js presentation
function generateRevealHtml(
  slides: RevealSlideRendererProps['slides']
): string {
  const slidesHtml = slides.map(slide => {
    if (slide.contentType === 'markdown') {
      return `<section data-markdown><script type="text/template">${slide.content}</script></section>`;
    }
    return `<section>${slide.content}</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/reset.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/theme/black.css">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .reveal {
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
      ${slidesHtml}
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.2.1/plugin/markdown/markdown.js"></script>
  <script>
    {
      let deck; // Declare deck outside to make it accessible
      deck = Reveal.initialize({
        embedded: true,
        controls: true,
        progress: true,
        center: true,
        hash: false,
        transition: 'slide',
        keyboard: true,
        touch: true,
        plugins: [RevealMarkdown]
      });

      deck.then(function() {
        // Notify parent of initialization
        window.parent.postMessage({ type: 'reveal-ready' }, '*');

        // Listen for slide changes and notify parent
        Reveal.on('slidechanged', function(event) {
          window.parent.postMessage({ 
            type: 'reveal-slidechanged', 
            indexh: event.indexh,
            indexv: event.indexv
          }, '*');
        });
      });
    }

    // Listen for commands from parent
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'reveal-goto') {
        Reveal.slide(event.data.indexh, event.data.indexv || 0);
      }
      if (event.data && event.data.type === 'reveal-configure') {
        Reveal.configure({
          controls: event.data.controls,
          keyboard: event.data.keyboard,
          touch: event.data.touch
        });
      }
    });

    // Interaction capture script
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
  </script>
</body>
</html>`;
}

const RevealSlideRenderer = memo(function RevealSlideRenderer({
  slides,
  currentSlideIndex,
  currentVerticalIndex,
  onSlideChange,
  isNavigationEnabled = true,
  currentInteraction,
  registerSlideNavigator
}: RevealSlideRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isReady, setIsReady] = useState(false);
  const onSlideChangeRef = useRef(onSlideChange);
  const currentSlideIndexRef = useRef(currentSlideIndex);
  const currentVerticalIndexRef = useRef(currentVerticalIndex);

  // Keep refs up to date
  useEffect(() => {
    onSlideChangeRef.current = onSlideChange;
  }, [onSlideChange]);

  useEffect(() => {
    currentSlideIndexRef.current = currentSlideIndex;
    currentVerticalIndexRef.current = currentVerticalIndex;
  }, [currentSlideIndex, currentVerticalIndex]);

  // Type guard for expected messages from iframe
  const isRevealMessage = (data: unknown): data is { type: string;[key: string]: unknown } => {
    return typeof data === 'object' && data !== null && 'type' in data;
  };

  // Handle messages from iframe
  const handleMessage = useCallback((event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!isRevealMessage(data)) return;

    if (data.type === 'reveal-ready') {
      setIsReady(true);
    }

    if (data.type === 'reveal-slidechanged') {
      const indexh = typeof data.indexh === 'number' ? data.indexh : 0;
      const indexv = typeof data.indexv === 'number' ? data.indexv : 0;

      if (onSlideChangeRef.current && (indexh !== currentSlideIndexRef.current || indexv !== currentVerticalIndexRef.current)) {
        onSlideChangeRef.current(indexh, indexv);
      }
    }
  }, []);

  // Listen for messages from iframe
  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  // Update iframe content when slides change
  useEffect(() => {
    if (!iframeRef.current || slides.length === 0) return;

    const html = generateRevealHtml(slides);
    const iframe = iframeRef.current;

    // Write content to iframe
    const doc = iframe.contentDocument;
    if (doc) {
      doc.open();
      doc.write(html);
      doc.close();
      setIsReady(false); // Reset ready state since we're reloading
    }
  }, [slides]); // Only reload if content changes, not when navigation state changes

  // Register direct navigation channel
  useEffect(() => {
    if (registerSlideNavigator) {
      registerSlideNavigator((indexh, indexv) => {
        if (iframeRef.current && iframeRef.current.contentWindow) {
          iframeRef.current.contentWindow.postMessage({
            type: 'reveal-goto',
            indexh,
            indexv
          }, '*');
        }
      });
    }
  }, [registerSlideNavigator]);

  // Sync slide index when it changes externally
  useEffect(() => {
    if (isReady && iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage({
        type: 'reveal-goto',
        indexh: currentSlideIndex,
        indexv: currentVerticalIndex
      }, '*');
    }
  }, [currentSlideIndex, currentVerticalIndex, isReady]);

  // Handle interaction replaying
  useEffect(() => {
    if (!isReady || !iframeRef.current || !currentInteraction) return;
    // We record interactions for potential navigation changes, 
    // but no visual rings or highlights are shown on the slides themselves.
  }, [currentInteraction, isReady]);

  // Update controls enabled state
  useEffect(() => {
    if (isReady && iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage({
        type: 'reveal-configure',
        controls: isNavigationEnabled,
        keyboard: isNavigationEnabled,
        touch: isNavigationEnabled
      }, '*');
    }
  }, [isNavigationEnabled, isReady]);

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-gray-900 text-gray-400">
        <p>No slides to display</p>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title="Reveal.js Presentation"
      className="block w-full h-full border-0 align-middle"
      sandbox="allow-scripts allow-same-origin"
    />
  );
});

export default RevealSlideRenderer;

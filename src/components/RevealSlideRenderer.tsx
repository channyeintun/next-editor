import { useEffect, useRef, useCallback, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import { Deck, Markdown, Slide as RevealReactSlide } from '@revealjs/react';
import revealResetCssUrl from 'reveal.js/reset.css?url';
import revealCoreCssUrl from 'reveal.js/reveal.css?url';
import revealThemeCssUrl from 'reveal.js/theme/black.css?url';
import type { RevealApi } from 'reveal.js';
import type { SlideContentType } from '../types/slides';
import { createIframeInteractionCaptureScript } from '../utils/iframeInteractionCapture';

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
  setSlideNavigator?: (navigator: (indexh: number, indexv: number) => void) => void;
}

function createRevealShellHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${revealResetCssUrl}">
  <link rel="stylesheet" href="${revealCoreCssUrl}">
  <link rel="stylesheet" href="${revealThemeCssUrl}">
  <style>
    html, body, #reveal-react-root {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    }
    .reveal {
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <div id="reveal-react-root"></div>
</body>
</html>`;
}

function RawHtmlSlide({ content }: { content: string }) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) {
      return;
    }

    container.innerHTML = content;

    for (const script of Array.from(container.querySelectorAll('script'))) {
      const nextScript = document.createElement('script');

      for (const { name, value } of Array.from(script.attributes)) {
        nextScript.setAttribute(name, value);
      }

      nextScript.textContent = script.textContent;
      script.replaceWith(nextScript);
    }
  }, [content]);

  return <div ref={contentRef} className="size-full" />;
}

function RevealDeckContent({
  deckRef,
  isNavigationEnabled,
  onReady,
  onSlideChange,
  slides,
}: {
  deckRef: React.MutableRefObject<RevealApi | null>;
  isNavigationEnabled: boolean;
  onReady: (deck: RevealApi) => void;
  onSlideChange: (indexh: number, indexv: number) => void;
  slides: RevealSlideRendererProps['slides'];
}) {
  const handleRevealSlideChange: EventListener = (event) => {
    const slideChangeEvent = event as Event & {
      indexh: number;
      indexv?: number;
    };

    onSlideChange(slideChangeEvent.indexh, slideChangeEvent.indexv ?? 0);
  };

  return (
    <Deck
      deckRef={deckRef}
      config={{
        embedded: true,
        controls: isNavigationEnabled,
        progress: true,
        center: true,
        hash: false,
        transition: 'slide',
        keyboard: isNavigationEnabled,
        touch: isNavigationEnabled,
      }}
      onReady={onReady}
      onSlideChange={handleRevealSlideChange}
    >
      {slides.map((slide) => {
        if (slide.contentType === 'markdown') {
          return <Markdown key={slide.id} markdown={slide.content} />;
        }

        return (
          <RevealReactSlide key={slide.id}>
            <RawHtmlSlide content={slide.content} />
          </RevealReactSlide>
        );
      })}
    </Deck>
  );
}

const RevealSlideRenderer = memo(function RevealSlideRenderer({
  slides,
  currentSlideIndex,
  currentVerticalIndex,
  onSlideChange,
  isNavigationEnabled = true,
  currentInteraction,
  setSlideNavigator
}: RevealSlideRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const deckRef = useRef<RevealApi | null>(null);
  const [iframeRoot, setIframeRoot] = useState<HTMLElement | null>(null);
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

  const handleDeckReady = useCallback((deck: RevealApi) => {
    deckRef.current = deck;
    setIsReady(true);
  }, []);

  const handleDeckSlideChange = useCallback((indexh: number, indexv: number) => {
    if (
      !onSlideChangeRef.current ||
      (indexh === currentSlideIndexRef.current && indexv === currentVerticalIndexRef.current)
    ) {
      return;
    }

    onSlideChangeRef.current(indexh, indexv);
  }, []);

  // Initialize the iframe document once, then render the React deck into it.
  useEffect(() => {
    if (!iframeRef.current || slides.length === 0) return;
    const iframe = iframeRef.current;
    const doc = iframe.contentDocument;

    if (!doc) {
      return;
    }

    doc.open();
    doc.write(createRevealShellHtml());
    doc.close();
    setIsReady(false);
    setIframeRoot(doc.getElementById('reveal-react-root'));

    const captureScript = createIframeInteractionCaptureScript(
      '__SLIDE_INTERACTION_CAPTURE_SETUP__',
      { includeMouseMove: false },
    );
    const scriptElement = doc.createElement('script');

    scriptElement.textContent = captureScript;
    doc.head.appendChild(scriptElement);

    return () => {
      deckRef.current?.destroy();
      deckRef.current = null;
      setIframeRoot(null);
      setIsReady(false);
    };
  }, [slides.length]);

  // Register direct navigation channel.
  useEffect(() => {
    if (!setSlideNavigator) {
      return;
    }

    setSlideNavigator((indexh, indexv) => {
      deckRef.current?.slide(indexh, indexv);
    });

    return () => {
      setSlideNavigator((_indexh, _indexv) => undefined);
    };
  }, [setSlideNavigator]);

  // Sync slide index when it changes externally.
  useEffect(() => {
    if (!isReady || !deckRef.current) {
      return;
    }

    const indices = deckRef.current.getIndices();
    const targetVerticalIndex = currentVerticalIndex ?? 0;

    if (indices.h === currentSlideIndex && (indices.v ?? 0) === targetVerticalIndex) {
      return;
    }

    deckRef.current.slide(currentSlideIndex, targetVerticalIndex);
  }, [currentSlideIndex, currentVerticalIndex, isReady]);

  // Handle interaction replaying
  useEffect(() => {
    if (!isReady || !iframeRef.current || !currentInteraction) return;
    // We record interactions for potential navigation changes, 
    // but no visual rings or highlights are shown on the slides themselves.
  }, [currentInteraction, isReady]);

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center bg-gray-900 text-gray-400 size-full">
        <p>No slides to display</p>
      </div>
    );
  }

  return (
    <>
      <iframe
        ref={iframeRef}
        title="Reveal.js Presentation"
        className="block border-0 align-middle size-full"
        sandbox="allow-scripts allow-same-origin"
      />
      {iframeRoot ? createPortal(
        <RevealDeckContent
          deckRef={deckRef}
          isNavigationEnabled={isNavigationEnabled}
          onReady={handleDeckReady}
          onSlideChange={handleDeckSlideChange}
          slides={slides}
        />,
        iframeRoot,
      ) : null}
    </>
  );
});

export default RevealSlideRenderer;

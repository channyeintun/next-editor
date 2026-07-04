import { useEffect, useRef, useState } from "react";
import { Deck, Markdown, Slide as RevealReactSlide } from "@revealjs/react";
import "reveal.js/reveal.css";
import "reveal.js/theme/black.css";
import type { RevealApi } from "reveal.js";
import type { SlideContentType } from "../types/slides";
import type { DeckStep } from "../googleSlides/types";
import { getSlideBackgroundImage } from "../config/slideBackgrounds";
import GoogleSvgSlide from "./GoogleSvgSlide";

interface RevealSlideRendererProps {
  slides: Array<{
    id: string;
    content: string;
    contentType: SlideContentType;
    background?: string;
    steps?: DeckStep[];
  }>;
  currentSlideIndex: number;
  currentVerticalIndex: number;
  onSlideChange?: (indexh: number, indexv?: number) => void;
  isNavigationEnabled?: boolean;
  currentInteraction?: import("../types/slides").IframeInteractionEvent;
  setSlideNavigator?: (navigator: (indexh: number, indexv: number) => void) => void;
}

function RawHtmlSlide({ content }: { content: string }) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) {
      return;
    }

    container.innerHTML = content;

    for (const script of Array.from(container.querySelectorAll("script"))) {
      const nextScript = document.createElement("script");

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
  currentSlideIndex,
  currentVerticalIndex,
}: {
  deckRef: React.MutableRefObject<RevealApi | null>;
  isNavigationEnabled: boolean;
  onReady: (deck: RevealApi) => void;
  onSlideChange: (indexh: number, indexv: number) => void;
  slides: RevealSlideRendererProps["slides"];
  currentSlideIndex: number;
  currentVerticalIndex: number;
}) {
  const handleRevealSlideChange = (event: Event) => {
    const slideChangeEvent = event as Event & {
      indexh: number;
      indexv?: number;
    };

    onSlideChange(slideChangeEvent.indexh, slideChangeEvent.indexv ?? 0);
  };

  // When any slide has build steps, arrow keys must reveal steps rather than
  // jump slides, so SlidePreview's keydown handler drives navigation and
  // Reveal's own keyboard is disabled to avoid the two fighting.
  const hasSteppedSlides = slides.some(
    (slide) => slide.contentType === "google-svg" && (slide.steps?.length ?? 0) > 0,
  );

  return (
    <Deck
      deckRef={deckRef}
      config={{
        embedded: true,
        controls: isNavigationEnabled,
        progress: true,
        center: true,
        hash: false,
        transition: "slide",
        keyboard: isNavigationEnabled && !hasSteppedSlides,
        touch: isNavigationEnabled && !hasSteppedSlides,
      }}
      onReady={onReady}
      onSlideChange={handleRevealSlideChange}
    >
      {slides.map((slide, index) => {
        const backgroundImage = getSlideBackgroundImage(slide.background);

        if (slide.contentType === "google-svg") {
          // The SVG is the artwork, so no Reveal background image. Build steps
          // are revealed via the vertical index of the active slide.
          const stepsRevealed = index === currentSlideIndex ? currentVerticalIndex : 0;
          return (
            <RevealReactSlide key={slide.id}>
              <GoogleSvgSlide
                content={slide.content}
                steps={slide.steps}
                stepsRevealed={stepsRevealed}
              />
            </RevealReactSlide>
          );
        }

        if (slide.contentType === "markdown") {
          return (
            <Markdown key={slide.id} markdown={slide.content} backgroundImage={backgroundImage} />
          );
        }

        return (
          <RevealReactSlide key={slide.id} backgroundImage={backgroundImage}>
            <RawHtmlSlide content={slide.content} />
          </RevealReactSlide>
        );
      })}
    </Deck>
  );
}

function RevealSlideRenderer({
  slides,
  currentSlideIndex,
  currentVerticalIndex,
  onSlideChange,
  isNavigationEnabled = true,
  currentInteraction,
  setSlideNavigator,
}: RevealSlideRendererProps) {
  const deckRef = useRef<RevealApi | null>(null);
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

  const handleDeckReady = (deck: RevealApi) => {
    deckRef.current = deck;
    setIsReady(true);
  };

  const handleDeckSlideChange = (indexh: number, indexv: number) => {
    if (
      !onSlideChangeRef.current ||
      (indexh === currentSlideIndexRef.current && indexv === currentVerticalIndexRef.current)
    ) {
      return;
    }

    onSlideChangeRef.current(indexh, indexv);
  };

  useEffect(() => {
    setIsReady(false);

    return () => {
      deckRef.current?.destroy();
      deckRef.current = null;
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
    if (!isReady || !currentInteraction) return;
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
    <div className="size-full bg-black">
      <RevealDeckContent
        deckRef={deckRef}
        isNavigationEnabled={isNavigationEnabled}
        onReady={handleDeckReady}
        onSlideChange={handleDeckSlideChange}
        slides={slides}
        currentSlideIndex={currentSlideIndex}
        currentVerticalIndex={currentVerticalIndex}
      />
    </div>
  );
}

export default RevealSlideRenderer;

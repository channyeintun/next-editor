import { Suspense, useEffect, useRef, useState } from "react";
import type { Slide } from "../types/slides";
import { getSlideBackgroundImage } from "../config/slideBackgrounds";
import { createSandboxedSlideDocument } from "../utils/sandboxedSlideDocument";
import { inlinableSlideImageHrefs, retainSlideImages } from "../utils/slideImageCache";
import GoogleSvgSlide from "./GoogleSvgSlide";
import { lazyWithRecovery } from "../routeRecovery";

// Only markdown slides need marked; lesson decks are google-svg. Until the
// chunk arrives the slide shows its black frame, as it does while any slide's
// iframe loads, and a buffered transition keeps the previous slide on screen
// until the new iframe's onLoad either way.
const MarkdownSlide = lazyWithRecovery(() => import("./MarkdownSlide"), "MarkdownSlide");

interface CustomSlideRendererProps {
  slides: Slide[];
  currentSlideIndex: number;
  currentVerticalIndex: number;
}

interface IsolatedSlideProps {
  content: string;
  onLoad?: () => void;
}

function RawHtmlSlide({ content, onLoad }: IsolatedSlideProps) {
  return (
    <iframe
      title="HTML slide"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={createSandboxedSlideDocument(content, "text/html")}
      onLoad={onLoad}
      className="size-full border-0 bg-black"
      style={{ colorScheme: "dark" }}
    />
  );
}

function SlideContent({
  slide,
  stepsRevealed,
  onLoad,
}: {
  slide: Slide;
  stepsRevealed: number;
  onLoad?: () => void;
}) {
  if (slide.contentType === "google-svg") {
    return (
      <GoogleSvgSlide
        content={slide.content}
        steps={slide.steps}
        stepsRevealed={stepsRevealed}
        onLoad={onLoad}
      />
    );
  }

  const backgroundImage = getSlideBackgroundImage(slide.background);

  return (
    <div
      className="flex size-full items-center justify-center bg-black bg-cover bg-center text-center text-white"
      style={backgroundImage ? { backgroundImage: `url(${backgroundImage})` } : undefined}
    >
      {slide.contentType === "markdown" ? (
        <Suspense fallback={null}>
          <MarkdownSlide content={slide.content} onLoad={onLoad} />
        </Suspense>
      ) : (
        <RawHtmlSlide content={slide.content} onLoad={onLoad} />
      )}
    </div>
  );
}

interface SlideLayer {
  key: number;
  slide: Slide;
  stepsRevealed: number;
}

function isSameSlideDocument(left: Slide, right: Slide): boolean {
  return (
    left.id === right.id && left.contentType === right.contentType && left.content === right.content
  );
}

function BufferedSlideContent({ slide, stepsRevealed }: { slide: Slide; stepsRevealed: number }) {
  const nextLayerKeyRef = useRef(1);
  const [displayed, setDisplayed] = useState<SlideLayer>(() => ({
    key: 0,
    slide,
    stepsRevealed,
  }));
  const [pending, setPending] = useState<SlideLayer | null>(null);

  useEffect(() => {
    if (isSameSlideDocument(displayed.slide, slide)) {
      setPending(null);
      return;
    }
    setPending((current) => {
      if (current && isSameSlideDocument(current.slide, slide)) return current;
      return {
        key: nextLayerKeyRef.current++,
        slide,
        stepsRevealed,
      };
    });
  }, [displayed.slide, slide, stepsRevealed]);

  // Reads the committed render's layer and slide: each commit hands the frames a
  // fresh onLoad, so a load always sees the latest committed pending layer.
  const promoteLoadedLayer = (key: number) => {
    const loaded = pending;
    if (!loaded || loaded.key !== key || !isSameSlideDocument(loaded.slide, slide)) {
      return;
    }
    setDisplayed(loaded);
    setPending((current) => (current?.key === key ? null : current));
  };

  const displayedLayer = isSameSlideDocument(displayed.slide, slide)
    ? { ...displayed, slide, stepsRevealed }
    : displayed;
  const pendingLayer = pending
    ? isSameSlideDocument(pending.slide, slide)
      ? { ...pending, slide, stepsRevealed }
      : pending
    : null;
  const layers = pendingLayer ? [displayedLayer, pendingLayer] : [displayedLayer];

  return (
    <div className="relative size-full overflow-hidden bg-black">
      {layers.map((layer) => {
        const isDisplayed = layer.key === displayed.key;
        return (
          <div
            key={layer.key}
            data-slide-buffer-state={isDisplayed ? "displayed" : "loading"}
            aria-hidden={isDisplayed ? undefined : true}
            // The loading layer sits *behind* the displayed one (z-0, fully
            // occluded by the opaque displayed layer) rather than at opacity-0.
            // Opacity-0 lets the browser skip painting the incoming SVG, so the
            // instant promote-on-load would reveal an unpainted (black) frame —
            // the transition "flash". Kept occluded-but-painted, the incoming
            // slide is already drawn when it is promoted, so the swap is seamless.
            className={`absolute inset-0 bg-black ${
              isDisplayed ? "z-10 opacity-100" : "pointer-events-none z-0"
            }`}
          >
            <SlideContent
              slide={layer.slide}
              stepsRevealed={layer.stepsRevealed}
              onLoad={() => promoteLoadedLayer(layer.key)}
            />
          </div>
        );
      })}
    </div>
  );
}

function CustomSlideRenderer({
  slides,
  currentSlideIndex,
  currentVerticalIndex,
}: CustomSlideRendererProps) {
  const slide = slides[currentSlideIndex];

  // The page holds fetched slide images in memory (slideImageCache.ts); keep only this deck's.
  useEffect(() => {
    retainSlideImages(
      slides.flatMap((deckSlide) =>
        deckSlide.contentType === "google-svg" ? inlinableSlideImageHrefs(deckSlide.content) : [],
      ),
    );
  }, [slides]);

  if (!slide) {
    return (
      <div className="flex items-center justify-center bg-gray-900 text-gray-400 size-full">
        <p>No slides to display</p>
      </div>
    );
  }

  return (
    <div className="size-full bg-black">
      <BufferedSlideContent slide={slide} stepsRevealed={currentVerticalIndex} />
    </div>
  );
}

export default CustomSlideRenderer;

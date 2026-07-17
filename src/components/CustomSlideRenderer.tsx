import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type { Slide } from "../types/slides";
import { getSlideBackgroundImage } from "../config/slideBackgrounds";
import { createSandboxedSlideDocument } from "../utils/sandboxedSlideDocument";
import GoogleSvgSlide from "./GoogleSvgSlide";

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

function MarkdownSlide({ content, onLoad }: IsolatedSlideProps) {
  const html = marked(content, { async: false });

  return (
    <iframe
      title="Markdown slide"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={createSandboxedSlideDocument(
        `<main class="slide-markdown" style="box-sizing:border-box;width:100%;height:100%;padding:3rem;color:white">${html}</main>`,
        "text/html",
      )}
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
        <MarkdownSlide content={slide.content} onLoad={onLoad} />
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
    left.id === right.id &&
    left.contentType === right.contentType &&
    left.content === right.content
  );
}

function BufferedSlideContent({
  slide,
  stepsRevealed,
}: {
  slide: Slide;
  stepsRevealed: number;
}) {
  const nextLayerKeyRef = useRef(1);
  const currentSlideRef = useRef(slide);
  currentSlideRef.current = slide;
  const [displayed, setDisplayed] = useState<SlideLayer>(() => ({
    key: 0,
    slide,
    stepsRevealed,
  }));
  const [pending, setPending] = useState<SlideLayer | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

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

  const promoteLoadedLayer = (key: number) => {
    const loaded = pendingRef.current;
    if (
      !loaded ||
      loaded.key !== key ||
      !isSameSlideDocument(loaded.slide, currentSlideRef.current)
    ) {
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
            className={`absolute inset-0 bg-black ${
              isDisplayed ? "z-10 opacity-100" : "pointer-events-none z-0 opacity-0"
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

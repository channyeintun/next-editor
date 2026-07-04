import { useEffect, useRef } from "react";
import { marked } from "marked";
import type { Slide } from "../types/slides";
import { getSlideBackgroundImage } from "../config/slideBackgrounds";
import GoogleSvgSlide from "./GoogleSvgSlide";

interface CustomSlideRendererProps {
  slides: Slide[];
  currentSlideIndex: number;
  currentVerticalIndex: number;
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

function MarkdownSlide({ content }: { content: string }) {
  const html = marked(content, { async: false });

  return (
    // eslint-disable-next-line react/no-danger -- markdown is the slide's own
    // authored content, same trust level as RawHtmlSlide's innerHTML injection.
    <div className="slide-markdown size-full p-12" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function SlideContent({ slide, stepsRevealed }: { slide: Slide; stepsRevealed: number }) {
  if (slide.contentType === "google-svg") {
    return (
      <GoogleSvgSlide content={slide.content} steps={slide.steps} stepsRevealed={stepsRevealed} />
    );
  }

  const backgroundImage = getSlideBackgroundImage(slide.background);

  return (
    <div
      className="flex size-full items-center justify-center bg-black bg-cover bg-center text-center text-white"
      style={backgroundImage ? { backgroundImage: `url(${backgroundImage})` } : undefined}
    >
      {slide.contentType === "markdown" ? (
        <MarkdownSlide content={slide.content} />
      ) : (
        <RawHtmlSlide content={slide.content} />
      )}
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
      <SlideContent slide={slide} stepsRevealed={currentVerticalIndex} />
    </div>
  );
}

export default CustomSlideRenderer;

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

function RawHtmlSlide({ content }: { content: string }) {
  return (
    <iframe
      title="HTML slide"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={createSandboxedSlideDocument(content, "text/html")}
      className="size-full border-0"
    />
  );
}

function MarkdownSlide({ content }: { content: string }) {
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
      className="size-full border-0"
    />
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

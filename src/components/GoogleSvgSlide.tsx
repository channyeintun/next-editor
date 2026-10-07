import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { DeckStep } from "../googleSlides/types";
import {
  SLIDE_ANIMATION_INIT_MESSAGE_TYPE,
  SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE,
  createSandboxedSlideDocument,
} from "../utils/sandboxedSlideDocument";
import {
  inlinableSlideImageHrefs,
  loadSlideImages,
  peekSlideImages,
} from "../utils/slideImageCache";

interface GoogleSvgSlideProps {
  /** Normalized inline SVG markup for one slide. */
  content: string;
  steps?: DeckStep[];
  /** Number of build steps to reveal (0..steps.length). */
  stepsRevealed: number;
  onLoad?: () => void;
}

/**
 * Renders one imported Google Slides slide as inline SVG scaled to fill the
 * slide area, and replays its build-step animations as `stepsRevealed` changes.
 * The SVG is isolated in a unique-origin iframe so its CSS cannot affect the
 * host app. A trusted, nonce-restricted child bridge receives only animation
 * state over postMessage; the parent never receives access to the slide DOM.
 */
export default function GoogleSvgSlide({
  content,
  steps,
  stepsRevealed,
  onLoad,
}: GoogleSvgSlideProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The frame cannot cache its own image loads, so it waits for the page to fetch
  // them once (slideImageCache.ts) and gets them inline. Until then nothing loads,
  // and BufferedSlideContent keeps the previous slide up as it did while the frame
  // downloaded them.
  const [loaded, setLoaded] = useState<{
    content: string;
    images: ReadonlyMap<string, string>;
  } | null>(null);
  const inlineImages =
    loaded?.content === content
      ? loaded.images
      : peekSlideImages(inlinableSlideImageHrefs(content));
  const isLoadingImages = inlineImages === null;
  const srcDoc = isLoadingImages
    ? null
    : createSandboxedSlideDocument(content, "image/svg+xml", {
        animationBridge: true,
        inlineImages,
      });

  useEffect(() => {
    if (!isLoadingImages) return;
    let cancelled = false;
    void loadSlideImages(inlinableSlideImageHrefs(content)).then((images) => {
      if (!cancelled) setLoaded({ content, images });
    });
    return () => {
      cancelled = true;
    };
  }, [content, isLoadingImages]);

  const initializeAnimation = useEffectEvent(() => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: SLIDE_ANIMATION_INIT_MESSAGE_TYPE,
        steps: steps ?? [],
        stepsRevealed,
      },
      "*",
    );
  });

  const revealSteps = useEffectEvent(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE, stepsRevealed },
      "*",
    );
  });

  // Reinitialize when the imported step model changes. The iframe load handler
  // repeats this after srcDoc navigation in case this effect ran beforehand.
  useEffect(() => {
    initializeAnimation();
  }, [srcDoc, steps]);

  // Drive step reveal without re-injecting or exposing the SVG document.
  useEffect(() => {
    revealSteps();
  }, [stepsRevealed]);

  if (srcDoc === null) {
    return <div className="size-full bg-black" />;
  }

  return (
    <iframe
      ref={iframeRef}
      title="Imported Google slide"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={() => {
        initializeAnimation();
        onLoad?.();
      }}
      className="size-full border-0 bg-black"
      style={{ colorScheme: "dark" }}
    />
  );
}

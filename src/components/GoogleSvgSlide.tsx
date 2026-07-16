import { useEffect, useEffectEvent, useRef } from "react";
import type { DeckStep } from "../googleSlides/types";
import {
  SLIDE_ANIMATION_INIT_MESSAGE_TYPE,
  SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE,
  createSandboxedSlideDocument,
} from "../utils/sandboxedSlideDocument";

interface GoogleSvgSlideProps {
  /** Normalized inline SVG markup for one slide. */
  content: string;
  steps?: DeckStep[];
  /** Number of build steps to reveal (0..steps.length). */
  stepsRevealed: number;
}

/**
 * Renders one imported Google Slides slide as inline SVG scaled to fill the
 * slide area, and replays its build-step animations as `stepsRevealed` changes.
 * The SVG is isolated in a unique-origin iframe so its CSS cannot affect the
 * host app. A trusted, nonce-restricted child bridge receives only animation
 * state over postMessage; the parent never receives access to the slide DOM.
 */
export default function GoogleSvgSlide({ content, steps, stepsRevealed }: GoogleSvgSlideProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = createSandboxedSlideDocument(content, "image/svg+xml", {
    animationBridge: true,
  });

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

  return (
    <iframe
      ref={iframeRef}
      title="Imported Google slide"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={initializeAnimation}
      className="size-full border-0 bg-black"
    />
  );
}

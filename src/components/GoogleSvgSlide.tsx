import { useEffect, useRef } from "react";
import { DeckStepAnimator } from "../googleSlides/animator";
import type { DeckStep } from "../googleSlides/types";
import { sanitizeSlideContent } from "../utils/sanitizeSlideContent";

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
 * The SVG is injected via innerHTML (not <img>) so it can load external images
 * and expose element ids to the animator.
 */
export default function GoogleSvgSlide({ content, steps, stepsRevealed }: GoogleSvgSlideProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animatorRef = useRef<DeckStepAnimator | null>(null);

  // Inject the SVG and (re)build the animator whenever the markup or steps change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = sanitizeSlideContent(content, "image/svg+xml");
    const svg = container.querySelector("svg");

    animatorRef.current?.dispose();
    animatorRef.current = null;

    if (svg instanceof SVGSVGElement) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.display = "block";
      svg.style.width = "100%";
      // Height is intentionally left unset. An <svg> with a viewBox but no
      // width/height attribute is a replaced element with an intrinsic aspect
      // ratio, so leaving height auto makes the browser derive a real,
      // non-zero height from the viewBox. Keeping the SVG in normal flow (not
      // absolutely positioned) lets that intrinsic height flow up to the
      // wrapper div below; an absolute/inset-0 wrapper would take the SVG out
      // of flow and collapse the box to zero height, rendering nothing.

      if (steps && steps.length > 0) {
        animatorRef.current = new DeckStepAnimator(svg, steps);
      }
    }

    return () => {
      animatorRef.current?.dispose();
      animatorRef.current = null;
    };
  }, [content, steps]);

  // Drive step reveal without re-injecting the SVG. Runs right after the
  // injection effect on mount, and on every stepsRevealed change thereafter.
  useEffect(() => {
    animatorRef.current?.setRevealed(stepsRevealed);
  }, [stepsRevealed]);

  // In normal flow (not absolutely positioned): this div's height comes from
  // its content (the injected SVG), which lets the surrounding slide container
  // size and center around a real, non-zero height.
  return <div ref={containerRef} className="w-full bg-black" />;
}

import { useEffect, useRef } from "react";
import { DeckStepAnimator } from "../googleSlides/animator";
import type { DeckStep } from "../googleSlides/types";

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

    container.innerHTML = content;
    const svg = container.querySelector("svg");

    animatorRef.current?.dispose();
    animatorRef.current = null;

    if (svg instanceof SVGSVGElement) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.display = "block";
      svg.style.width = "100%";
      // Height is intentionally left unset. Reveal never sets an explicit
      // height on a slide's <section> (only width: 100%), so its height
      // comes from its in-flow content. An <svg> with a viewBox but no
      // width/height attribute is a replaced element with an intrinsic
      // aspect ratio, so leaving height auto makes the browser derive a
      // real, non-zero height from the viewBox -- that's what gives the
      // section something to size around. The previous absolute/inset-0
      // wrapper took the SVG out of flow entirely, so the section collapsed
      // to zero height and the slide rendered nothing.

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
  // its content (the injected SVG), which is what gives Reveal's <section> a
  // real height to lay out and center around.
  return <div ref={containerRef} className="w-full bg-black" />;
}

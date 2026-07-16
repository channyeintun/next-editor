import { useEffect, useEffectEvent, useRef } from "react";
import { DeckStepAnimator } from "../googleSlides/animator";
import type { DeckStep } from "../googleSlides/types";
import { createSandboxedSlideDocument } from "../utils/sandboxedSlideDocument";

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
 * The SVG is isolated in a script-disabled iframe so its CSS cannot affect the
 * host app while the parent can still access element ids for step animation.
 */
export default function GoogleSvgSlide({ content, steps, stepsRevealed }: GoogleSvgSlideProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const animatorRef = useRef<DeckStepAnimator | null>(null);
  const srcDoc = createSandboxedSlideDocument(content, "image/svg+xml");

  const setupAnimator = useEffectEvent(() => {
    const svg = iframeRef.current?.contentDocument?.querySelector<SVGSVGElement>("svg");

    animatorRef.current?.dispose();
    animatorRef.current = null;

    // Nodes from an iframe belong to its realm, so parent-window `instanceof`
    // checks fail even for a real SVGSVGElement. querySelector's typed result is
    // the realm-safe contract here.
    if (svg) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.display = "block";
      svg.style.width = "100%";

      if (steps && steps.length > 0) {
        animatorRef.current = new DeckStepAnimator(svg, steps);
        animatorRef.current.setRevealed(stepsRevealed);
      }
    }
  });

  // Rebuild the animator after the isolated iframe document has loaded.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    iframe.addEventListener("load", setupAnimator);
    if (iframe.contentDocument?.readyState === "complete") {
      setupAnimator();
    }

    return () => {
      iframe.removeEventListener("load", setupAnimator);
      animatorRef.current?.dispose();
      animatorRef.current = null;
    };
  }, [srcDoc, steps]);

  // Drive step reveal without re-injecting the SVG. Runs right after the
  // injection effect on mount, and on every stepsRevealed change thereafter.
  useEffect(() => {
    animatorRef.current?.setRevealed(stepsRevealed);
  }, [stepsRevealed]);

  return (
    <iframe
      ref={iframeRef}
      title="Imported Google slide"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="size-full border-0 bg-black"
    />
  );
}

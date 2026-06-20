import { useEffect, useRef, useState } from "react";

export interface CollapseTransitionState {
  /** Whether the collapsible panel should be rendered in the DOM. */
  isMounted: boolean;
  /** Whether the panel should be at its full (open) size. */
  isExpanded: boolean;
  /** Whether the size transition is active — gate the CSS transition on this. */
  isAnimating: boolean;
}

interface CollapseTransitionOptions {
  /** Transition duration in ms; must match the CSS `duration-*` on the element. */
  durationMs?: number;
  /** When false, toggles snap instantly (no animation, no mid-slide mount). */
  enabled?: boolean;
}

/**
 * Drives an open/close slide for a layout panel whose size also changes for other
 * reasons (e.g. a drag-to-resize handle). The transition is only enabled during
 * the brief toggle window, so resizing stays instant instead of lagging behind.
 *
 * On open the panel mounts at its collapsed size and expands on the next frame so
 * the size genuinely transitions (changing both in one commit would snap); on
 * close it shrinks first, then unmounts once it is offscreen.
 */
export function useCollapseTransition(
  isCollapsed: boolean,
  { durationMs = 200, enabled = true }: CollapseTransitionOptions = {},
): CollapseTransitionState {
  const [isExpanded, setIsExpanded] = useState(!isCollapsed);
  const [isMounted, setIsMounted] = useState(!isCollapsed);
  const [isAnimating, setIsAnimating] = useState(false);
  const previousCollapsedRef = useRef(isCollapsed);

  useEffect(() => {
    // Ignore the initial mount (and StrictMode's remount); only react to a real
    // open/close toggle so the panel doesn't animate on first paint.
    if (previousCollapsedRef.current === isCollapsed) {
      return;
    }
    previousCollapsedRef.current = isCollapsed;

    // Snap without animating when transitions are disabled (e.g. during replay,
    // where an animated width would mismap proportionally-scaled cursor targets).
    if (!enabled) {
      setIsAnimating(false);
      setIsExpanded(!isCollapsed);
      setIsMounted(!isCollapsed);
      return;
    }

    setIsAnimating(true);
    let openFrame = 0;

    if (isCollapsed) {
      setIsExpanded(false);
    } else {
      setIsMounted(true);
      openFrame = window.requestAnimationFrame(() => setIsExpanded(true));
    }

    const settleTimer = window.setTimeout(() => {
      setIsAnimating(false);
      if (isCollapsed) {
        setIsMounted(false);
      }
    }, durationMs + 60);

    return () => {
      window.clearTimeout(settleTimer);
      if (openFrame) {
        window.cancelAnimationFrame(openFrame);
      }
    };
  }, [durationMs, enabled, isCollapsed]);

  return { isMounted, isExpanded, isAnimating };
}

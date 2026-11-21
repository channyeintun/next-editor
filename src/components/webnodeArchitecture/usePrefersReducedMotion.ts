import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  // A query without change events (an old browser, a test double) is read once.
  if (!query || typeof query.addEventListener !== "function") {
    return () => {};
  }
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const getSnapshot = () => reducedMotionQuery()?.matches === true;

/** Whether the visitor asked the system for less motion, followed as it changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

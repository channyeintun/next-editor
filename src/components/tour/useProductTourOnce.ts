import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { startTour } from "./productTour";

/** Same selector usePlayerShortcuts.ts uses for the editor surface (TYPING_TARGETS). */
const EDITOR_SURFACE = ".monaco-editor";

export interface ProductTourOnceOptions {
  recordingLoading: boolean;
  loadError: string | null;
  readOnly: boolean;
  /** From useAuthorInteractionFlag in the editor shell. */
  authorInteracted: RefObject<boolean>;
}

/**
 * Whether the author already holds focus somewhere, so the tour must not take
 * it. `interacted` is the shell's key/pointer flag. The active element covers
 * focus that arrived with no in-page event: Tab from the browser's address bar
 * lands on the first control with :focus-visible set. The code editor's own
 * mount focus (CodeEditor's focusEditorIfNeeded) is the app's placement, not
 * the author's, and sits there on every load where the page has focus.
 */
export function authorHoldsFocus(doc: Document, interacted: boolean): boolean {
  if (interacted) return true;
  const active = doc.activeElement;
  if (!active || active === doc.body) return false;
  if (active.closest(EDITOR_SURFACE)) return false;
  try {
    return active.matches(":focus-visible");
  } catch {
    return true; // cannot tell how focus was placed: do not take it
  }
}

/**
 * True once the author has pressed a key or a pointer anywhere since the editor
 * shell mounted. Called from EditorLayout, not from the tour, so it is live
 * while the CodeEditor chunk loads — the window in which an author tabs to the
 * header or the player bar. A ref, not state: nothing re-renders on it.
 */
export function useAuthorInteractionFlag(): RefObject<boolean> {
  const interactedRef = useRef(false);
  useEffect(() => {
    const mark = () => {
      interactedRef.current = true;
    };
    // Capture on window so no later handler can hide the event
    // (CodeEditor adds a window-capture keydown handler that stops Ctrl/Cmd+Z).
    window.addEventListener("keydown", mark, true);
    window.addEventListener("pointerdown", mark, true);
    return () => {
      window.removeEventListener("keydown", mark, true);
      window.removeEventListener("pointerdown", mark, true);
    };
  }, []);
  return interactedRef;
}

/**
 * Starts the product tour once per editor mount. Not inside read-only embeds (the
 * landing-page demo iframe), and only after any URL-driven recording load has
 * finished; never when the load failed — the editor is then showing an error
 * panel, not a touchable surface.
 *
 * Never while the author holds focus (WCAG 3.0 2.4.1 "Focus user-controlled"):
 * once they have pressed a key or a pointer, or tabbed to a control, the tour
 * stays unstarted for this load and 'Take a Tour' remains the way in.
 *
 * Accepted residual: the tour still moves focus from <body>, or from the code
 * editor's own mount focus, into its popover without an author action — driver.js
 * 1.9.0 focuses the popover's first control, and on close restores focus to the
 * element that was active at drive() time (__activeOnDestroyed). Removing that
 * last move needs an invitation card instead of the auto-start, a product
 * decision (P07-10, option A).
 */
export function useProductTourOnce({
  recordingLoading,
  loadError,
  readOnly,
  authorInteracted,
}: ProductTourOnceOptions): void {
  const tourStartedRef = useRef(false);

  useEffect(() => {
    if (recordingLoading || loadError || readOnly || tourStartedRef.current) {
      return;
    }

    // Defer one frame so the lazily-mounted editor chrome (header, runner dock)
    // has painted before we query the `data-tour` targets. The frame is left to
    // fire on its own — cancelling it in cleanup would let StrictMode's dev
    // double-invoke abort the tour entirely (run #1 schedules, cleanup cancels,
    // run #2 short-circuits on the ref), so the tour would never auto-start.
    tourStartedRef.current = true;
    requestAnimationFrame(() => {
      // Read at fire time, after the code editor's mount focus and after paint.
      // Skipped, not seen: hasSeenTour() stays false, so the next visit tries again
      // and 'Take a Tour' in the settings menu is always the way in.
      if (authorHoldsFocus(document, authorInteracted.current)) return;
      void startTour();
    });
  }, [recordingLoading, loadError, readOnly]);
}

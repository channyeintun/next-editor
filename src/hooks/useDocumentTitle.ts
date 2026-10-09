import { useEffect } from "react";

/** The shell's own `<title>` (index.html), which the landing page keeps. */
export const SITE_TITLE = "Next Editor | Interactive Code Recording & Replay";

/**
 * Names the current view in the document title (WCAG 2.4.2 Page Titled), so a
 * client-side navigation retitles the tab, the history entry and the page a
 * screen reader announces. Every route view calls it once, above any early
 * return, with a title for each state it can render.
 *
 * Unmounting resets the title to SITE_TITLE, never to the title it replaced:
 * that can be the lesson title the edge renderer wrote into the HTML of the
 * first page loaded (infra/worker/ssr/lessonDetail.ts).
 *
 * Pass null while a child view owns the title. React runs a child's effects
 * before its parent's, so two owners would leave the parent's title in place.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    document.title = title;
    return () => {
      document.title = SITE_TITLE;
    };
  }, [title]);
}

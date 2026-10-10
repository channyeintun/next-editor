import { useLocation } from "react-router";

/**
 * `?embed=true` — the page is running inside somebody else's iframe
 * (kite-lang.dev embeds /learn/kite-crash-course on its front page).
 *
 * Chrome that navigates away from the lesson comes off: the breadcrumb's
 * "Lessons" link would replace the lesson with the gallery *inside the frame*,
 * leaving the reader in a frame-sized copy of this site with no way back. The
 * landing page's own demo iframe already looks this way — it points at /code
 * with `readOnly=true`, and CodeRoute drops the breadcrumb for a read-only
 * editor. This is the same thing for a route that has no readOnly flag to
 * borrow, since every lesson is read-only already.
 *
 * `useLocation` rather than `useSearchParams`, because the hydrate fallback in
 * router.tsx asks this too, and useLocation is the one that needs nothing but
 * the router context.
 */
export function useEmbedded(): boolean {
  const { search } = useLocation();
  return isEmbedded(search);
}

/** The flag itself, for tests and for anything outside a component. */
export function isEmbedded(search: string): boolean {
  return new URLSearchParams(search).get("embed") === "true";
}

export const READ_ONLY_PARAM = "readOnly";

/**
 * `?readOnly=true` — /code opens a read-only editor; the landing page's demo
 * iframe loads it this way. CodeRoute, Editor and isLandingDemoFrame all read
 * the flag through here, so the URL contract has one home.
 */
export function isReadOnlyView(search: string | URLSearchParams): boolean {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get(READ_ONLY_PARAM) === "true";
}

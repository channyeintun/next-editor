// postMessage contract between the landing page and the /code demo iframe it
// embeds. The embed loads with ?largeControls=true so the playback controls stay
// legible while the iframe is scaled down to fit the hero card; fullscreen shows
// the editor at native resolution instead, where the parent pushes the controls
// back to their regular size. Kept light: LandingPage is also rendered by the
// SSR worker, and the only import is the pure ?readOnly reader.

import { isReadOnlyView } from "./embed";

/** Parent -> embed: `{ type, large: boolean }`. */
export const DEMO_CONTROLS_SIZE_MESSAGE_TYPE = "NEXT_EDITOR_DEMO_CONTROLS_SIZE";

/** Embed -> parent, announced once the embed's message listener is mounted. The
 *  editor bundle loads lazily, so a fullscreen toggle during boot would otherwise
 *  send a size message before anyone is listening; the announce lets the parent
 *  re-deliver the current size instead of losing it. */
export const DEMO_EMBED_READY_MESSAGE_TYPE = "NEXT_EDITOR_DEMO_EMBED_READY";

/** Whether this document is that embed: /code booted with the flags LandingPage's
 *  DEMO_IFRAME_SRC sets, inside a same-origin parent. A cross-origin parent can't
 *  be read, so a third-party frame never counts. */
export function isLandingDemoFrame(): boolean {
  if (window.parent === window) return false;
  const search = new URLSearchParams(window.location.search);
  if (!isReadOnlyView(search) || search.get("largeControls") !== "true") return false;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

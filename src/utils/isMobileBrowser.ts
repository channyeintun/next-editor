/**
 * Best-effort mobile/tablet detection. Heavy in-browser surfaces — the
 * WebContainer runtime and the landing page's embedded live-editor demo iframe —
 * spike memory enough on mobile browsers (iOS Safari, Android Chrome) that the OS
 * reloads or kills the tab. We detect mobile so those surfaces stay disabled
 * rather than crashing the page.
 *
 * Kept dependency-free so it can be imported from the light landing critical path
 * without dragging in the WebContainer support module.
 */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  // Client Hints are the reliable signal where available (Chromium).
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") {
    return uaData.mobile;
  }

  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports a desktop Safari UA, so treat a touch-capable "Macintosh"
  // (a real Mac never reports touch points) as a tablet too.
  const isIpadOs =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;

  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua) || isIpadOs
  );
}

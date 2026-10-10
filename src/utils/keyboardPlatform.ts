/**
 * Whether the keyboard's command key is Cmd (macOS, iOS, iPadOS), so app
 * shortcuts take Meta there and Ctrl everywhere else. On Apple keyboards Ctrl
 * keeps its text-editing meanings (Ctrl+P moves the caret up a line).
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  // Client Hints where available (Chromium); navigator.platform elsewhere.
  // iPadOS reports "MacIntel", which is right here: its keyboards have Cmd too.
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac|ios|iphone|ipad|ipod/i.test(platform);
}

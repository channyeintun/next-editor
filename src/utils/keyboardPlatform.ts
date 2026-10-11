// Keyboard rules shared across the app: the command key, keys an input method
// owns, and which letter a shortcut key is.

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

/**
 * Whether a key belongs to an input method. keyCode 229 is a key it handled:
 * Safari sends the Enter that commits a composition after compositionend,
 * with isComposing already false.
 */
export function isImeComposingKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Whether a key press is `letter` (lowercase) for a shortcut. The letter is read
 * from `key`, so Caps Lock, Dvorak and AZERTY work; a layout whose key types no
 * Latin letter (Burmese, Cyrillic, Greek) falls back to the physical key. A
 * character picked with AltGr or Option keeps to the layout: Polish AltGr+S
 * types ś, which Windows reports with Ctrl held.
 */
export function isLetterKey(
  event: Pick<KeyboardEvent, "key" | "code" | "altKey">,
  letter: string,
): boolean {
  const key = event.key.toLowerCase();
  if (key === letter) return true;
  return !event.altKey && !/^[a-z]$/.test(key) && event.code === `Key${letter.toUpperCase()}`;
}

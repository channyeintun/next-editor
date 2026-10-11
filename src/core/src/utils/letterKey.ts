// ============================================================================
// Which letter a shortcut key is. The one home for the rule: the app's
// shortcuts (Save, room undo, Go to File) and playback's pause-on-typing
// filter both read it. The app reaches it through utils/keyboardPlatform.
// ============================================================================

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

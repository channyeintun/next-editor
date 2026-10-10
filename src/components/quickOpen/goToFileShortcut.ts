// ============================================================================
// The Go to File key: Cmd+P on Apple keyboards, Ctrl+P everywhere else, as in
// VS Code. The one home of the binding, its label and its aria-keyshortcuts.
// ============================================================================

type GoToFileKeyPress = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode"
>;

/**
 * Whether a key belongs to an input method. keyCode 229 is a key it handled:
 * Safari sends the Enter that commits a composition after compositionend,
 * with isComposing already false.
 */
export function isImeComposingKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Whether a key press asks for Go to File. Only the platform's command
 * modifier counts, so Monaco keeps Ctrl+P on a Mac (caret up, previous
 * suggestion) and its find widget keeps Alt+P; Shift+P stays free for a
 * command palette. Letters are read from `key`, so Caps Lock and Dvorak work;
 * a layout whose key for P types no Latin letter (Burmese, Cyrillic) falls
 * back to the physical key.
 */
export function isGoToFileShortcut(event: GoToFileKeyPress, isApple: boolean): boolean {
  if (isImeComposingKey(event) || event.altKey || event.shiftKey) return false;
  if (!(isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return false;
  const key = event.key.toLowerCase();
  return key === "p" || (!/^[a-z]$/.test(key) && event.code === "KeyP");
}

/** The shortcut as a person reads it: "⌘P" or "Ctrl+P". */
export function goToFileShortcutLabel(isApple: boolean): string {
  return isApple ? "⌘P" : "Ctrl+P";
}

/** The shortcut for `aria-keyshortcuts`. */
export function goToFileAriaKeyShortcuts(isApple: boolean): string {
  return isApple ? "Meta+P" : "Control+P";
}

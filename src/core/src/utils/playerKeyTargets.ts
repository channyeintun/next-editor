// ============================================================================
// Which keys belong to the player. A key pressed with focus somewhere that
// takes typing, has keys of its own, or (for Space) is pressed by it, belongs
// there instead. The one home for the rule: the player's shortcuts and the
// editor's Space-to-pause during playback both read it.
// ============================================================================

/** Places that take typing: the editor, the terminal, the whiteboard, and form fields. */
const TYPING_TARGETS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .monaco-editor, .xterm, .excalidraw";
/** Places with keys of their own: dialogs, menus, and widgets that arrow keys move. */
const OWN_KEYS_TARGETS =
  "[role='dialog'], [aria-modal='true'], [role='menu'], [role='listbox'], [role='slider'], [role='separator'], [role='tablist'], [role='tree'], [role='grid'], [role='radiogroup']";
/** Elements Space presses; the press is theirs. */
const PRESSABLE = "button, [role='button'], a[href], summary, [role='menuitem'], [role='tab']";

/** Whether `target` takes typing, so a key pressed there types into it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    Boolean(target.closest(TYPING_TARGETS)) || (target as HTMLElement).isContentEditable === true
  );
}

/** Whether Space pressed with focus on `target` presses a control (a button, link, tab…). */
export function isPressableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(PRESSABLE));
}

/** Whether a key pressed with focus on `target` belongs to the player. */
export function isPlayerKeyTarget(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return true;
  if (isTypingTarget(target) || target.closest(OWN_KEYS_TARGETS)) return false;
  return !(key === " " && isPressableTarget(target));
}

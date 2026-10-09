/**
 * Whether an editor that is mounting, or whose lesson just started playing,
 * may take the caret.
 *
 * **Never take focus a document does not already have.** This runs on mount,
 * so an editor mounting in a document the reader is not in would pull the
 * caret out of wherever they actually were. Embedded in an iframe that is the
 * visible failure: the Kite crash course on kite-lang.dev mounted, took focus,
 * and the browser scrolled the parent page down to the frame — a reader who
 * had opened the site was moved into the middle of it without touching
 * anything.
 *
 * `hasFocus()` is the right question rather than "am I in a frame?", because
 * the same theft happens in a background tab and on a page restored from
 * history.
 *
 * **Never take focus the reader placed with the keyboard.** The editor mounts
 * after its lazy chunk loads and playback can start by itself (autoplay), so a
 * keyboard user who has already tabbed to a header link, or pressed Play with
 * Space or Enter, would be dropped into the editor, where Tab and Space edit
 * the lesson code (WCAG 3 "focus user-controlled"). `:focus-visible` is the
 * browser's own record of keyboard-placed focus, and it also covers a field the
 * reader is typing in. Focus left on the page itself, or on a button the reader
 * clicked with the mouse, still moves into the editor as before. Keeping focus
 * on Play costs a keyboard user nothing: while a lesson plays in an editor
 * without text focus, replay draws its own caret decoration in place of
 * Monaco's hidden one (`applyFrameState` in core's frameReplay.ts).
 */
export function mayTakeFocus(domNode: HTMLElement | null | undefined): boolean {
  const doc = domNode?.ownerDocument;
  if (!doc?.hasFocus()) return false;
  const active = doc.activeElement;
  if (!active || active === doc.body) return true;
  try {
    return !active.matches(":focus-visible");
  } catch {
    // A browser that cannot answer cannot tell keyboard focus apart: leave it.
    return false;
  }
}

/**
 * Whether an editor about to mount may take the caret.
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
 * history. Once the reader clicks into the editor the document does have
 * focus, so pressing play and a lesson typing behave exactly as before.
 */
export function mayTakeFocus(domNode: HTMLElement | null | undefined): boolean {
  return domNode?.ownerDocument.hasFocus() ?? false;
}

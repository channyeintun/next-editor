/**
 * Text preparation for AthanLab narration: the speech text of one dialog,
 * rewritten to AthanLab's writing rules (https://athanlab.com/docs) before it
 * is sent. Sentences end with `။`, `!` or `?`; quotation marks, brackets and
 * the ellipsis are dropped; `၊` marks a pause. Pure, so the exact text a take
 * was bought for is reproducible from its speech text.
 */

/**
 * Version of the text this module sends for a given speech text. The dialog
 * cache keys on speech text, not on what AthanLab is asked to speak, so any
 * change here that alters the sent text must bump this or cached dialogs keep
 * replaying audio bought for the old text (the AthanLab voice profile carries
 * it, so it reaches the request hash).
 *
 * v1: quotes, brackets and ellipses dropped; a missing sentence end becomes `။`
 */
export const ATHANLAB_TEXT_PREP_VERSION = 1;

/** Quotation marks AthanLab would otherwise read or pause on. */
const QUOTE_MARKS_RE = /["“”„‘«»]/g;
/**
 * A `'` or `’` used as a quote: any one not between two Latin letters or
 * digits. Kept only inside English words, where it is an apostrophe (`don't`,
 * `Rust’s`). Burmese joins a particle straight onto the word before it, so a
 * closing quote is often followed by a letter (`‘mut’ကို`) and still has to go.
 */
const QUOTE_APOSTROPHE_RE = /(?<![A-Za-z0-9])['’]|['’](?![A-Za-z0-9])/g;
const BRACKETS_RE = /[()[\]{}]/g;
/** `…` or a run of three or more dots: a trailing-off pause. */
const ELLIPSIS_RE = /…|\.{3,}/g;
/** Endings AthanLab reads as a finished sentence or a pause. */
const SENTENCE_END_RE = /[။!?.၊]$/u;

/** The text AthanLab is asked to speak for one dialog's speech text. */
export function prepareAthanLabText(text: string): string {
  const prepared = text
    .replace(QUOTE_MARKS_RE, "")
    .replace(QUOTE_APOSTROPHE_RE, "")
    .replace(BRACKETS_RE, "")
    .replace(ELLIPSIS_RE, "၊ ")
    .replace(/\s+/g, " ")
    .trim();
  if (!prepared || SENTENCE_END_RE.test(prepared)) {
    return prepared;
  }
  return `${prepared}။`;
}
